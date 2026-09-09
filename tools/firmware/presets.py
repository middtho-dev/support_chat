"""Validated first-boot UCI configuration. All values are shell arguments, never code."""
import ipaddress,re,shlex
q=shlex.quote

def text(value,label,minimum=0,maximum=128):
    if not isinstance(value,str) or not minimum<=len(value.encode())<=maximum or any(ord(c)<32 or ord(c)==127 for c in value):raise ValueError(label+': некорректное значение')
    return value

def boolean(value,label):
    if type(value) is not bool:raise ValueError(label+': нужен переключатель')
    return value

def integer(value,label,low,high):
    if type(value) is not int or not low<=value<=high:raise ValueError(label+': число вне диапазона')
    return value

def ipv4(value,label):
    try:return str(ipaddress.IPv4Address(value))
    except Exception:raise ValueError(label+': нужен IPv4-адрес')

def network(address,mask,label):
    address=ipv4(address,label)
    try:
        net=ipaddress.IPv4Network(address+'/'+str(mask),strict=False)
        if not 8<=net.prefixlen<=30 or ipaddress.IPv4Address(address) in [net.network_address,net.broadcast_address]:raise ValueError()
        return address,str(net.netmask),net
    except Exception:raise ValueError(label+': неверная маска или адрес сети')

def validate(body):
    if not isinstance(body,dict):raise ValueError('Нужны настройки сборки')
    out={'name':text(body.get('name',''),'Имя устройства',1,80),'frpc':boolean(body.get('frpc',True),'FRPC'),'podkop':boolean(body.get('podkop',True),'Podkop')}
    out['localIP']=str(ipaddress.ip_address(body.get('localIP','127.0.0.1')))
    out['localPort']=integer(body.get('localPort',80),'Порт назначения',1,65535)
    wan=body.get('wan',{})
    if not isinstance(wan,dict):raise ValueError('Некорректные настройки WAN')
    mode=wan.get('mode','keep')
    if mode not in ['keep','dhcp','pppoe','static']:raise ValueError('Неизвестный режим WAN')
    out['wan']={'mode':mode}
    if mode!='keep':
        out['wan']['mtu']=integer(wan.get('mtu',1492 if mode=='pppoe' else 1500),'MTU',576,1500)
        dns=text(wan.get('dns',''),'DNS',0,64).split()
        if len(dns)>3:raise ValueError('Не более трёх DNS-серверов')
        out['wan']['dns']=[ipv4(x,'DNS') for x in dns]
    if mode=='pppoe':out['wan'].update(username=text(wan.get('username',''),'Логин PPPoE',1),password=text(wan.get('password',''),'Пароль PPPoE',1,256))
    if mode=='static':
        address,mask,net=network(wan.get('ip'),wan.get('mask'),'WAN')
        gateway=ipv4(wan.get('gateway'),'Шлюз WAN')
        if ipaddress.IPv4Address(gateway) not in net or gateway==address:raise ValueError('Шлюз WAN должен находиться в подсети WAN и отличаться от адреса роутера')
        out['wan'].update(ip=address,mask=mask,gateway=gateway)
    lan=body.get('lan',{})
    if not isinstance(lan,dict):raise ValueError('Некорректные настройки LAN')
    out['lan']={'configure':boolean(lan.get('configure',False),'Настройка LAN')}
    if out['lan']['configure']:
        address,mask,net=network(lan.get('ip'),lan.get('mask'),'LAN')
        dhcp=boolean(lan.get('dhcp',True),'DHCP LAN');start=integer(lan.get('start',100),'Начало DHCP',1,65534);limit=integer(lan.get('limit',100),'Количество DHCP',1,65534)
        if dhcp and (start+limit>=net.num_addresses or start<=int(ipaddress.IPv4Address(address))-int(net.network_address)<start+limit):raise ValueError('Диапазон DHCP выходит за подсеть или включает адрес роутера')
        if mode=='static' and net.overlaps(ipaddress.IPv4Network(out['wan']['ip']+'/'+out['wan']['mask'],strict=False)):raise ValueError('Подсети WAN и LAN не должны пересекаться')
        out['lan'].update(ip=address,mask=mask,dhcp=dhcp,start=start,limit=limit)
    wifi=body.get('wifi',[])
    if not isinstance(wifi,list) or len(wifi)>2:raise ValueError('Нужны настройки диапазонов Wi-Fi')
    out['wifi']=[];bands=set()
    for w in wifi:
        if not isinstance(w,dict):raise ValueError('Некорректные настройки Wi-Fi')
        band=w.get('band')
        if band not in ['2g','5g'] or band in bands:raise ValueError('Некорректный диапазон Wi-Fi')
        bands.add(band);item={'band':band,'configure':boolean(w.get('configure',False),'Настройка Wi-Fi')}
        if item['configure']:
            item['enabled']=boolean(w.get('enabled',False),'Wi-Fi')
            if item['enabled']:
                item['ssid']=text(w.get('ssid',''),'SSID',1,32);item['security']=w.get('security','psk2')
                if item['security'] not in ['psk2','sae-mixed','sae','none']:raise ValueError('Неподдерживаемая защита Wi-Fi')
                item['password']='' if item['security']=='none' else text(w.get('password',''),'Пароль Wi-Fi',8,63)
                item['hidden']=boolean(w.get('hidden',False),'Скрытый SSID')
                item['country']=text(w.get('country','RU'),'Код страны',2,2).upper()
                if not re.fullmatch('[A-Z]{2}',item['country']):raise ValueError('Код страны: две латинские буквы')
        out['wifi'].append(item)
    return out

def config_script(config):
    lines=['#!/bin/sh','set -eu','umask 077','# Applies once on a clean sysupgrade. Saved overlay configuration has precedence.']
    def setval(key,value):lines.append('uci set '+q(key+'='+str(value)))
    def delete(key):lines.append('uci -q delete '+q(key)+' || true')
    wan=config['wan'];lan=config['lan']
    if wan['mode']!='keep':
        setval('network.wan','interface');setval('network.wan.proto',wan['mode']);setval('network.wan.mtu',wan['mtu'])
        for key in ['username','password','ipaddr','netmask','gateway','dns']:delete('network.wan.'+key)
        for key in ['username','password']:
            if key in wan:setval('network.wan.'+key,wan[key])
        for key,name in [('ip','ipaddr'),('mask','netmask'),('gateway','gateway')]:
            if key in wan:setval('network.wan.'+name,wan[key])
        setval('network.wan.peerdns','0' if wan['dns'] else '1')
        for dns in wan['dns']:lines.append('uci add_list '+q('network.wan.dns='+dns))
    if lan['configure']:
        setval('network.lan.proto','static');setval('network.lan.ipaddr',lan['ip']);setval('network.lan.netmask',lan['mask'])
        setval('dhcp.lan','dhcp');setval('dhcp.lan.interface','lan');setval('dhcp.lan.ignore','0' if lan['dhcp'] else '1');setval('dhcp.lan.start',lan['start']);setval('dhcp.lan.limit',lan['limit']);setval('dhcp.lan.leasetime','12h')
    if any(w['configure'] for w in config['wifi']):lines.append('wifi config')
    for w in config['wifi']:
        if not w['configure']:continue
        lines+=['found=0',r"for radio in $(uci show wireless | sed -n 's/^wireless\.\([^.=]*\)=wifi-device$/\1/p'); do",'band=$(uci -q get "wireless.$radio.band" || true)','[ "$band" = '+q(w['band'])+' ] || continue','found=1','uci set "wireless.$radio.disabled='+('0' if w['enabled'] else '1')+'"']
        if w['enabled']:
            lines+=['uci set "wireless.$radio.country='+w['country']+'"',r"for iface in $(uci show wireless | sed -n 's/^wireless\.\([^.=]*\)=wifi-iface$/\1/p'); do",'[ "$(uci -q get "wireless.$iface.device")" != "$radio" ] || uci set "wireless.$iface.disabled=1"','done','iface="kv9_$radio"','uci set "wireless.$iface=wifi-iface"','uci set "wireless.$iface.device=$radio"','uci set "wireless.$iface.mode=ap"','uci set "wireless.$iface.network=lan"']
            for k,v in [('ssid',w['ssid']),('encryption',w['security']),('key',w['password']),('hidden','1' if w['hidden'] else '0'),('disabled','0')]:lines.append('uci set "wireless.$iface.'+k+'="'+q(v))
        lines+=['done','[ "$found" = 1 ] || { logger -t kv9-firmware "Configured Wi-Fi band not found"; exit 1; }']
    lines+=['uci commit network','uci commit dhcp','uci commit wireless']
    if config['podkop']:lines+=['/etc/init.d/podkop disable','/etc/init.d/sing-box disable']
    if config['frpc']:lines.append('/etc/init.d/kv9-frpc-enroll enable')
    lines+=['logger -t kv9-firmware "Preset applied"','exit 0']
    return '\n'.join(lines)+'\n'

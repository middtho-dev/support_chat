import unittest,struct,copy,shlex
from image import pack_image,inspect_image,PREFIX
from presets import validate,config_script
class FirmwareTests(unittest.TestCase):
    def image(self):
        root=bytearray(16000);root[:4]=b'hsqs';struct.pack_into('<I',root,12,262144);struct.pack_into('<H',root,20,4)
        meta={'supported_devices':['xiaomi,mi-router-ax3000t'],'version':{'board':'xiaomi_mi-router-ax3000t','target':'mediatek/filogic','version':'25.12.5'}}
        members={PREFIX:None,PREFIX+'/CONTROL':b'BOARD=xiaomi_mi-router-ax3000t\n',PREFIX+'/kernel':b'kernel-data',PREFIX+'/root':bytes(root)}
        return pack_image(members,meta)
    def test_round_trip_crc_and_kernel(self):
        data=self.image();info,members=inspect_image(data)
        self.assertEqual(inspect_image(pack_image(members,info['metadata']))[0]['kernelSha256'],info['kernelSha256'])
        broken=bytearray(data);broken[1024]^=1
        with self.assertRaisesRegex(ValueError,'CRC'):inspect_image(broken)
        with self.assertRaises(ValueError):inspect_image(b'not firmware')
    def test_no_guessing_other_board_or_compression(self):
        info,members=inspect_image(self.image());info['metadata']['version']['board']='another-router'
        with self.assertRaises(ValueError):pack_image(members,info['metadata'])
    def test_network_validation(self):
        body={'name':'Router','lan':{'configure':True,'ip':'192.168.1.1','mask':'255.255.255.0','dhcp':True,'start':100,'limit':100}}
        self.assertEqual(validate(body)['lan']['ip'],'192.168.1.1')
        for change in [{'ip':'192.168.1.0'},{'mask':'255.0.255.0'},{'start':1},{'limit':200}]:
            with self.subTest(change=change),self.assertRaises(ValueError):validate({**body,'lan':{**body['lan'],**change}})
        with self.assertRaisesRegex(ValueError,'пересекаться'):validate({**body,'wan':{'mode':'static','ip':'192.168.1.2','mask':'255.255.255.0','gateway':'192.168.1.3'}})
    def test_passwords_and_ssid_are_shell_arguments(self):
        password="abc'$(touch /tmp/WRONG)";ssid='KV9RU $HOME'
        body={'name':'Router','wifi':[{'band':'2g','configure':True,'enabled':True,'ssid':ssid,'password':password,'security':'sae-mixed'}]}
        config=validate(body);script=config_script(config)
        self.assertNotIn('\x01',script);self.assertIn('\\1/p',script)
        line=next(l for l in script.splitlines() if 'wireless.$iface.key=' in l)
        self.assertEqual(shlex.split(line),['uci','set','wireless.$iface.key='+password])
        with self.assertRaises(ValueError):validate({**body,'wifi':[{**body['wifi'][0],'password':'short'}]})
        with self.assertRaises(ValueError):validate({**body,'wifi':[{**body['wifi'][0],'ssid':'я'*20}]})
    def test_off_and_keep_do_not_require_credentials(self):
        config=validate({'name':'Router','wifi':[{'band':'5g','configure':True,'enabled':False}]})
        script=config_script(config);self.assertIn('disabled=1',script);self.assertNotIn('network.wan',script)
        self.assertIn('/etc/init.d/podkop disable',script)
        with self.assertRaises(ValueError):validate({'name':'Router','frpc':'true'})


class FirstBootTests(unittest.TestCase):
    @unittest.skipUnless(__import__('shutil').which('sh'),'Linux shell integration')
    def test_real_shell_preserves_quoted_values_and_configures_both_radios(self):
        import tempfile,os,json,subprocess,sys
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);db=root/'uci.json'
            db.write_text(json.dumps({'wireless.radio0':'wifi-device','wireless.radio0.band':'2g','wireless.radio1':'wifi-device','wireless.radio1.band':'5g','wireless.default_radio0':'wifi-iface','wireless.default_radio0.device':'radio0'}))
            stub='#!'+sys.executable+'''\nimport sys,os,json
from pathlib import Path
p=Path(os.environ['MOCK_UCI']);d=json.loads(p.read_text());args=[a for a in sys.argv[1:] if a!='-q'];command=args[0]
if command=='show':
 for k,v in d.items():
  if k.startswith(args[1]+'.'):print(k+'='+v)
elif command=='get':
 if args[1] not in d:sys.exit(1)
 print(d[args[1]])
elif command=='set':
 k,v=args[1].split('=',1);d[k]=v
elif command=='delete':d.pop(args[1],None)
elif command=='add_list':
 k,v=args[1].split('=',1);d[k]=v
p.write_text(json.dumps(d))
'''
            (root/'uci').write_text(stub);(root/'uci').chmod(0o755)
            for name in ['wifi','logger']:(root/name).write_text('#!/bin/sh\nexit 0\n');(root/name).chmod(0o755)
            password="a'$(echo BAD) test";ssid='Test $HOME'
            body={'name':'TV','frpc':False,'podkop':False,'wan':{'mode':'pppoe','username':"user'name",'password':password},'lan':{'configure':True,'ip':'192.168.88.1','mask':'255.255.255.0'},'wifi':[{'band':'2g','configure':True,'enabled':True,'ssid':ssid,'password':password},{'band':'5g','configure':True,'enabled':False}]}
            script=root/'preset.sh';script.write_text(config_script(validate(body)))
            subprocess.run(['sh','-n',str(script)],check=True)
            subprocess.run(['sh',str(script)],check=True,env={**os.environ,'PATH':str(root)+':'+os.environ['PATH'],'MOCK_UCI':str(db)})
            state=json.loads(db.read_text());self.assertEqual(state['network.wan.password'],password);self.assertEqual(state['network.lan.ipaddr'],'192.168.88.1');self.assertEqual(state['wireless.kv9_radio0.ssid'],ssid);self.assertEqual(state['wireless.kv9_radio0.key'],password);self.assertEqual(state['wireless.default_radio0.disabled'],'1');self.assertEqual(state['wireless.radio1.disabled'],'1')

if __name__=='__main__':unittest.main()

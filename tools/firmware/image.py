"""OpenWrt sysupgrade container validation; never execute uploaded firmware."""
import hashlib, io, json, re, struct, tarfile, zlib
MAX_IMAGE=64*1024*1024
BOARD='xiaomi_mi-router-ax3000t'
PREFIX='sysupgrade-'+BOARD

def inspect_image(data):
    if not 10240<len(data)<=MAX_IMAGE:raise ValueError('Размер образа должен быть не более 64 МиБ')
    magic,crc,kind,size=struct.unpack('>IIB3xI',data[-16:])
    if magic!=0x46577830 or kind!=1 or not 24<size<32768:raise ValueError('Нужен sysupgrade с метаданными OpenWrt; factory/подписанные образы не поддерживаются')
    if (zlib.crc32(data[:-16])^0xffffffff)!=crc:raise ValueError('Повреждён образ: CRC метаданных не совпадает')
    start=len(data)-size
    if data[start:start+8]!=b'\0'*8:raise ValueError('Неизвестный формат метаданных')
    meta=json.loads(data[start+8:-16]);v=meta.get('version',{})
    if v.get('board')!=BOARD or v.get('target')!='mediatek/filogic' or not re.fullmatch(r'25\.12\.\d+',v.get('version','')) or meta.get('supported_devices')!=['xiaomi,mi-router-ax3000t']:
        raise ValueError('Пока поддерживается Xiaomi AX3000T: OpenWrt 25.12.x, mediatek/filogic, squashfs sysupgrade')
    members={}
    with tarfile.open(fileobj=io.BytesIO(data[:start]),mode='r:') as archive:
        for m in archive:
            if m.name in members or m.name not in [PREFIX,PREFIX+'/CONTROL',PREFIX+'/kernel',PREFIX+'/root']:raise ValueError('Неожиданная структура sysupgrade')
            if m.name==PREFIX:
                if not m.isdir():raise ValueError('Некорректный каталог sysupgrade')
                members[m.name]=None;continue
            if not m.isfile() or m.size>MAX_IMAGE:raise ValueError('Недопустимый элемент sysupgrade')
            members[m.name]=archive.extractfile(m).read()
    if len(members)!=4:raise ValueError('В образе отсутствует kernel, root или CONTROL')
    root=members[PREFIX+'/root'];kernel=members[PREFIX+'/kernel']
    if root[:4]!=b'hsqs' or len(root)<96 or not kernel:raise ValueError('Нужен squashfs rootfs и непустое ядро')
    block=struct.unpack_from('<I',root,12)[0];compression=struct.unpack_from('<H',root,20)[0]
    if compression!=4 or block not in [65536,131072,262144,524288,1048576]:raise ValueError('Поддерживается squashfs XZ со стандартным размером блока')
    return {'metadata':meta,'version':v['version'],'board':BOARD,'block':block,'size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'kernelSha256':hashlib.sha256(kernel).hexdigest()},members

def pack_image(members,metadata):
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as archive:
        for name in [PREFIX,PREFIX+'/CONTROL',PREFIX+'/kernel',PREFIX+'/root']:
            item=tarfile.TarInfo(name);item.uid=item.gid=0;item.mode=0o755 if name==PREFIX else 0o644
            if name==PREFIX:item.type=tarfile.DIRTYPE;archive.addfile(item)
            else:item.size=len(members[name]);archive.addfile(item,io.BytesIO(members[name]))
    meta=b'\0'*8+json.dumps(metadata,separators=(',',':')).encode()+b'\n';body=out.getvalue()+meta
    result=body+struct.pack('>IIB3xI',0x46577830,zlib.crc32(body)^0xffffffff,1,len(meta)+16)
    inspect_image(result)
    return result

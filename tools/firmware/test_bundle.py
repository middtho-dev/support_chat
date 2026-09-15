import io,json,tarfile,tempfile,unittest,zipfile
from pathlib import Path
from bundle import create_bundle,sha,FORMAT
from presets import validate

class BundleTests(unittest.TestCase):
    def test_original_bytes_and_first_boot_payload(self):
        image=b'original firmware bytes\x00\xff';token='a'*64
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'bundle.zip'
            config=validate({'name':'Router','lan':{'configure':True,'ip':'192.168.88.1','mask':'255.255.255.0'}})
            result=create_bundle(image,{'sha256':sha(image),'kernelSha256':'kernel','version':'25.12.5'},config,{'token':token,'endpoint':'https://panel.example.org/api/frp/enroll'},{'frpc-1.apk':b'package'},output)
            self.assertEqual(result['format'],FORMAT);self.assertEqual(result['sourceSha256'],sha(image));self.assertEqual(result['sha256'],sha(output.read_bytes()))
            self.assertNotIn(token,json.dumps(result))
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.read('firmware.bin'),image)
                self.assertNotIn(b'mksquashfs',archive.read('install.ps1'))
                self.assertIn(b'sysupgrade -T -f settings.tar.gz firmware.bin',archive.read('check.sh'))
                for line in archive.read('SHA256SUMS').decode().splitlines():
                    digest,name=line.split('  ');self.assertEqual(sha(archive.read(name)),digest)
                with tarfile.open(fileobj=io.BytesIO(archive.read('settings.tar.gz'))) as config_tar:
                    names=config_tar.getnames()
                    self.assertFalse(any('podkop' in p or 'sing-box' in p for p in names))
                    self.assertFalse(any(p in names for p in ['etc/config/network','etc/shadow','bin/busybox','sbin/init']))
                    self.assertIn(b'192.168.88.1',config_tar.extractfile('etc/uci-defaults/zzzz-kv9-preset').read())
                    link=config_tar.getmember('etc/rc.d/S99kv9-frpc-enroll');self.assertTrue(link.issym());self.assertEqual(link.linkname,'../init.d/kv9-frpc-enroll')
                    self.assertEqual(config_tar.getmember('etc/kv9-frpc-enrollment').mode,0o600)
                    self.assertIn(b'/usr/libexec/kv9-frpc-provision',config_tar.extractfile('etc/init.d/kv9-frpc-enroll').read())
    def test_no_frpc_means_no_capability_or_package_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'bundle.zip'
            create_bundle(b'original',{'sha256':sha(b'original'),'kernelSha256':'kernel','version':'25.12.5'},validate({'name':'Router','frpc':False}),None,{},output)
            with zipfile.ZipFile(output) as z,tarfile.open(fileobj=io.BytesIO(z.read('settings.tar.gz'))) as t:
                self.assertEqual(t.getnames(),['etc/uci-defaults/zzzz-kv9-preset'])

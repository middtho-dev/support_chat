import hashlib,os,shutil,subprocess,tempfile,unittest
from pathlib import Path

@unittest.skipUnless(shutil.which('sh'),'Linux shell required')
class ProvisionTests(unittest.TestCase):
    def test_offline_install_failure_does_not_start_frpc_and_success_cleans_payload(self):
        for result in [1,0]:
            with self.subTest(result=result),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);directory=root/'etc/kv9-firmware';directory.mkdir(parents=True)
                (directory/'constraints').write_text('frpc=1\nluci-app-frpc=2~a\n')
                (directory/'repositories').write_text(str(directory/'repos/1/packages.adb')+'\n')
                digest=hashlib.sha256((directory/'constraints').read_bytes()).hexdigest()
                (directory/'SHA256SUMS').write_text(digest+'  constraints\n')
                for name in ['usr/bin/frpc','etc/init.d/frpc']:
                    p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('#!/bin/sh\nexit 0\n');p.chmod(0o755)
                enrollment=root/'usr/libexec/kv9-frpc-enroll';enrollment.parent.mkdir(parents=True);enrollment.write_text('#!/bin/sh\ntouch "'+str(root/'started')+'"\n')
                commands=root/'commands';commands.mkdir()
                (commands/'apk').write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "'+str(root/'args')+'"\nexit '+str(result)+'\n');(commands/'apk').chmod(0o755)
                (commands/'logger').write_text('#!/bin/sh\nexit 0\n');(commands/'logger').chmod(0o755)
                script=(Path(__file__).parent/'provision.sh').read_text().replace('/etc/',str(root)+'/etc/').replace('/usr/',str(root)+'/usr/')
                path=root/'provision.sh';path.write_text(script)
                completed=subprocess.run(['sh',str(path)],env={**os.environ,'PATH':str(commands)+':'+os.environ['PATH']},capture_output=True,text=True)
                self.assertEqual(completed.returncode,result,completed.stderr)
                args=(root/'args').read_text().splitlines();self.assertIn('--no-network',args);self.assertIn('--repositories-file',args);self.assertNotIn('--allow-untrusted',args);self.assertIn('luci-app-frpc=2~a',args)
                self.assertEqual((root/'started').exists(),result==0)
                self.assertEqual((root/'etc/kv9-frpc-packages-ready').exists(),result==0)
                self.assertEqual((directory/'constraints').exists(),result!=0)

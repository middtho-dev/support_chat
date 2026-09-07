import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import devices

class DeviceTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.root=Path(self.directory.name)
    def tearDown(self):self.directory.cleanup()
    def register(self):return devices.public(self.root,'register',{'name':'Test TV'},'203.0.113.1')
    def poll(self,token,applied=0):return devices.public(self.root,'poll',{'token':token,'applied':applied,'snapshot':{'internal_torrclient':'false'}},'203.0.113.1')

    def test_pair_configuration_ack_and_revocation_are_device_scoped(self):
        one=self.register();two=self.register()
        self.assertFalse(self.poll(one['token'])['paired'])
        devices.manage(self.root,{'action':'pair','code':one['code']})
        listing=devices.listing(self.root);device=listing['devices'][0]
        self.assertNotIn(one['token'],str(listing));self.assertNotIn(one['code'],str(listing))
        devices.manage(self.root,{'action':'configure','id':device['id'],'values':{'internal_torrclient':'true'},'reload':False})
        self.assertEqual(self.poll(one['token'])['values'],{'internal_torrclient':'true'})
        self.assertEqual(self.poll(two['token'])['values'],{})
        self.assertEqual(self.poll(one['token'],1)['values'],{})
        self.assertEqual(devices.listing(self.root)['devices'][0]['applied'],1)
        devices.manage(self.root,{'action':'revoke','id':device['id']})
        with self.assertRaises(PermissionError):self.poll(one['token'])

    def test_expiry_unknown_settings_and_reused_codes(self):
        one=self.register()
        devices.manage(self.root,{'action':'pair','code':one['code']})
        with self.assertRaises(ValueError):devices.manage(self.root,{'action':'pair','code':one['code']})
        with self.assertRaises(ValueError):devices.values({'account':'secret'})
        with self.assertRaises(ValueError):devices.values({'internal_torrclient':True})
        two=self.register()
        with patch.object(devices.time,'time',return_value=10**12):
            with self.assertRaises(ValueError):devices.manage(self.root,{'action':'pair','code':two['code']})
            with self.assertRaises(PermissionError):self.poll(two['token'])

    def test_pending_commands_cannot_be_silently_overwritten(self):
        one=self.register();devices.manage(self.root,{'action':'pair','code':one['code']})
        identifier=devices.listing(self.root)['devices'][0]['id']
        body={'action':'configure','id':identifier,'values':{'screensaver':'false'},'reload':False}
        devices.manage(self.root,body)
        with self.assertRaises(ValueError):devices.manage(self.root,body)
        self.poll(one['token'],999)
        self.assertEqual(devices.listing(self.root)['devices'][0]['applied'],0)

if __name__=='__main__':unittest.main()

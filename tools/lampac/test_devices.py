from contextlib import closing
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import devices

class DeviceTests(unittest.TestCase):
    def test_automatic_enrollment_rename_and_reversible_access_preserve_id(self):
        registration=devices.public(self.root,'enroll',{'name':'Lampa PC'},'203.0.113.1')
        self.assertTrue(registration['paired'])
        identifier=registration['id'];cookie='workspace_device='+registration['token']
        self.assertEqual(devices.listing(self.root)['devices'][0]['id'],identifier)
        self.assertFalse(devices.access_allowed(self.root,cookie))
        devices.manage(self.root,{'action':'rename','id':identifier,'name':'Living room'})
        devices.manage(self.root,{'action':'access','id':identifier,'enabled':False})
        self.assertFalse(devices.access_allowed(self.root,cookie))
        self.assertFalse(self.poll(registration['token'])['enabled'])
        self.assertTrue(devices.access_allowed(self.root,''))
        devices.manage(self.root,{'action':'access','id':identifier,'enabled':True})
        self.assertTrue(devices.access_allowed(self.root,cookie))
        self.assertEqual(devices.listing(self.root)['devices'][0]['name'],'Living room')
        self.assertEqual(devices.listing(self.root)['devices'][0]['id'],identifier)

    def test_migration_preserves_existing_access_and_new_devices_require_activation(self):
        old=devices.public(self.root,'enroll',{'name':'Existing'},'203.0.113.1')
        devices.manage(self.root,{'action':'access','id':old['id'],'enabled':True})
        new=devices.public(self.root,'enroll',{'name':'New'},'203.0.113.1')
        self.assertTrue(self.poll(old['token'])['enabled'])
        self.assertFalse(self.poll(new['token'])['enabled'])
        self.poll(new['token'])
        devices.public(self.root,'poll',{'token':new['token'],'applied':0,'snapshot':{}},'203.0.113.1')
        row=next(d for d in devices.listing(self.root)['devices'] if d['id']==new['id'])
        self.assertEqual(row['snapshot'],{'internal_torrclient':'false'})

    def test_deleted_credentials_lose_access_and_reenrollment_starts_disabled(self):
        old=devices.public(self.root,'enroll',{'name':'TV'},'203.0.113.1')
        cookie='workspace_device='+old['token']
        devices.manage(self.root,{'action':'access','id':old['id'],'enabled':True})
        self.assertTrue(devices.access_allowed(self.root,cookie))
        devices.manage(self.root,{'action':'revoke','id':old['id']})
        self.assertFalse(devices.access_allowed(self.root,cookie))
        self.assertTrue(devices.access_allowed(self.root,cookie,allow_unknown=True))
        with self.assertRaises(PermissionError):self.poll(old['token'])
        new=devices.public(self.root,'enroll',{'name':'TV'},'203.0.113.1')
        self.assertNotEqual(old['id'],new['id'])
        self.assertFalse(new['enabled'])
        self.assertFalse(devices.access_allowed(self.root,'workspace_device='+new['token'],allow_unknown=True))

    def test_device_overrides_are_cumulative_and_can_return_to_inheritance(self):
        r=devices.public(self.root,'enroll',{'name':'TV'},'203.0.113.1');identifier=r['id']
        def save(values,inherit=[]):devices.manage(self.root,{'action':'configure','id':identifier,'values':values,'inherit':inherit,'reload':False})
        save({'screensaver':'false'})
        self.poll(r['token'],1)
        save({'internal_torrclient':'true'})
        result=self.poll(r['token'],2)
        self.assertEqual(result['overrides'],{'screensaver':'false','internal_torrclient':'true'})
        self.assertEqual(result['values'],{})
        save({},['screensaver'])
        self.assertEqual(self.poll(r['token'],3)['overrides'],{'internal_torrclient':'true'})

    def test_individual_ui_controls_roundtrip_and_revoke(self):
        r=devices.public(self.root,'enroll',{'name':'TV'},'203.0.113.1')
        key='workspace_ui_i_0123456789abcdef'
        controls=[{'key':key,'label':'Очистить кеш','group':'Пункты: Хранилище'}]
        devices.public(self.root,'poll',{'token':r['token'],'applied':0,'snapshot':{},'controls':controls},'203.0.113.1')
        self.assertEqual(devices.control_listing(self.root),controls)
        self.assertTrue(any(f['key']==key for f in devices.listing(self.root)['fields']))
        devices.manage(self.root,{'action':'configure','id':r['id'],'values':{key:'true'},'reload':False})
        self.assertEqual(self.poll(r['token'],1)['overrides'][key],'true')
        devices.manage(self.root,{'action':'configure','id':r['id'],'values':{},'inherit':[key],'reload':False})
        self.assertNotIn(key,self.poll(r['token'])['overrides'])
        with self.assertRaises(ValueError):
            devices.public(self.root,'poll',{'token':r['token'],'applied':0,'snapshot':{},'controls':[dict(controls[0],key='account_password')]},'203.0.113.1')
        self.assertEqual(devices.control_listing(self.root),controls)
        with self.assertRaises(ValueError):devices.values({key:'arbitrary'})
        devices.manage(self.root,{'action':'revoke','id':r['id']})
        self.assertEqual(devices.control_listing(self.root),[])

    def test_duplicate_controls_migrate_without_losing_overrides(self):
        r=devices.public(self.root,'enroll',{'name':'TV'},'203.0.113.1')
        alias=devices.advanced.discovered_key('m','movie');key='workspace_menu_movie'
        with closing(devices.database(self.root)) as conn, conn:
            conn.execute('UPDATE devices SET desired=? WHERE id=?',(devices.json.dumps({alias:'false',key:'true'}),r['id']))
        self.assertEqual(self.poll(r['token'])['overrides'],{key:'false'})
        devices.manage(self.root,{'action':'configure','id':r['id'],'values':{key:'true'},'reload':False})
        self.assertEqual(self.poll(r['token'],1)['overrides'],{key:'true'})
        devices.manage(self.root,{'action':'configure','id':r['id'],'values':{},'inherit':[key],'reload':False})
        self.assertEqual(self.poll(r['token'],2)['overrides'],{})

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

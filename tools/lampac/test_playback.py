import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import devices

class PlaybackTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.r=devices.public(self.root,'enroll',{'name':'TV'},'192.0.2.1')
        devices.manage(self.root,{'action':'access','id':self.r['id'],'enabled':True})
        self.data=dict(session='session_1234',state='playing',title='Film',source='media.example.org',hash='a'*40,method='browser',position=60,duration=120,buffer=12,error='')
    def beat(self,data=None,token=None):
        return devices.public(self.root,'heartbeat',{'token':token or self.r['token'],'playback':data or self.data},'192.0.2.1')
    def test_freshness_expiry_and_heartbeat_without_inventory(self):
        with patch('time.time',return_value=1000):self.beat()
        with patch('time.time',return_value=1089):
            result=devices.playback_listing(self.root);self.assertTrue(result['sessions'][0]['fresh']);self.assertEqual(result['devices'][0]['last'],1000)
        with patch('time.time',return_value=1090):self.assertFalse(devices.playback_listing(self.root)['sessions'][0]['fresh'])
        with patch('time.time',return_value=1301):self.assertEqual(devices.playback_listing(self.root)['sessions'],[])
    def test_optional_poster_keeps_older_clients_compatible(self):
        self.beat()
        self.assertEqual(devices.playback_listing(self.root)['sessions'][0]['poster'],'')
        self.beat(dict(self.data,poster='/poster123.jpg'))
        self.assertEqual(devices.playback_listing(self.root)['sessions'][0]['poster'],'https://image.tmdb.org/t/p/w300/poster123.jpg')
        for value in ['https://evil.example/image.jpg','https://image.tmdb.org/t/p/w300/a.jpg?token=secret','javascript:alert(1)',{'url':'bad'}]:
            self.beat(dict(self.data,poster=value))
            self.assertEqual(devices.playback_listing(self.root)['sessions'][0]['poster'],'')

    def test_ipv6_source_hostname(self):
        self.beat(dict(self.data,source='[2001:db8::1]'))
        self.assertEqual(devices.playback_listing(self.root)['sessions'][0]['source'],'[2001:db8::1]')

    def test_authentication_disabled_and_revoked(self):
        with self.assertRaises(PermissionError):self.beat(token='x'*43)
        devices.manage(self.root,{'action':'access','id':self.r['id'],'enabled':False})
        self.assertFalse(self.beat()['enabled']);self.assertEqual(devices.playback_listing(self.root)['sessions'],[])
        devices.manage(self.root,{'action':'access','id':self.r['id'],'enabled':True});self.beat()
        devices.manage(self.root,{'action':'revoke','id':self.r['id']})
        self.assertEqual(devices.playback_listing(self.root)['sessions'],[])
        with self.assertRaises(PermissionError):self.beat()
    def test_rejects_urls_secrets_and_invalid_measurements(self):
        for key,value in [('source','https://host/path?token=secret'),('title','https://host/?token=secret'),('buffer',float('nan')),('duration',-1),('position',True),('state',{}),('error','secret message'),('hash','not-a-hash')]:
            with self.subTest(key=key):
                with self.assertRaises(ValueError):self.beat(dict(self.data,**{key:value}))
        self.assertEqual(devices.playback_listing(self.root)['sessions'],[])
    def test_tabs_are_separate_and_bounded_and_stop_removes_record(self):
        self.beat(dict(self.data,state='error',error='decode'))
        self.beat(dict(self.data,state='ended',error='decode'))
        self.assertEqual(devices.playback_listing(self.root)['sessions'],[])
        self.beat(dict(self.data,state='ended',error='decode'))
        self.assertEqual(devices.playback_listing(self.root)['sessions'],[])
        for i in range(10):self.beat(dict(self.data,session='session_'+str(i)))
        self.assertEqual(len(devices.playback_listing(self.root)['sessions']),8)

    def test_manual_cleanup_is_scoped_and_preserves_live_sessions(self):
        with patch('time.time',return_value=1000):self.beat()
        with patch('time.time',return_value=1100):
            self.beat(dict(self.data,session='session_live'))
            result=devices.playback_remove(self.root,{'action':'remove','device':self.r['id'],'session':self.data['session']})
            self.assertEqual(result['removed'],1)
            self.assertEqual(devices.playback_listing(self.root)['sessions'][0]['session'],'session_live')
            with self.assertRaises(ValueError):devices.playback_remove(self.root,{'action':'remove','device':self.r['id'],'session':'session_live'})
            self.assertEqual(devices.playback_remove(self.root,{'action':'clear-inactive'})['removed'],0)
        with patch('time.time',return_value=1200):
            self.assertEqual(devices.playback_remove(self.root,{'action':'clear-inactive'})['removed'],1)
            self.assertEqual(devices.playback_listing(self.root)['sessions'],[])
        with self.assertRaises(ValueError):devices.playback_remove(self.root,{'action':'remove','device':self.r['id']})

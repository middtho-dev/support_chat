import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import devices

class AnnouncementsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.one=self.enroll('One');self.two=self.enroll('Two')
    def tearDown(self):self.tmp.cleanup()
    def enroll(self,name):
        r=devices.public(self.root,'enroll',{'name':name},'203.0.113.1')
        devices.manage(self.root,{'action':'access','id':r['id'],'enabled':True});return r
    def send(self,target='all',repeats=1):
        return devices.manage(self.root,{'action':'announce','target':target,'title':'Notice','message':'Line one\nLine two <script>','button':'Understood','repeats':repeats,'intervalMinutes':1})
    def poll(self,r):
        return devices.public(self.root,'poll',{'token':r['token'],'applied':0,'snapshot':{}},'203.0.113.1')['announcement']
    def ack(self,r,item):
        return devices.public(self.root,'announcement-ack',{'token':r['token'],'id':item['id'],'occurrence':item['occurrence']},'203.0.113.1')
    def test_broadcast_targets_existing_devices_and_ack_is_idempotent(self):
        result=self.send();self.assertEqual(result['recipients'],2)
        item=self.poll(self.one);self.assertEqual(item,self.poll(self.one))
        self.ack(self.one,item);self.ack(self.one,item)
        self.assertIsNone(self.poll(self.one));self.assertIsNotNone(self.poll(self.two))
        later=self.enroll('Later');self.assertIsNone(self.poll(later))
        self.assertEqual(devices.listing(self.root)['announcements'][0]['shown'],1)
    def test_target_isolation_repeats_interval_and_cancellation(self):
        self.send(self.one['id'],2);item=self.poll(self.one)
        self.assertIsNone(self.poll(self.two));self.ack(self.two,item)
        self.assertEqual(devices.listing(self.root)['announcements'][0]['shown'],0)
        self.ack(self.one,item);self.assertIsNone(self.poll(self.one))
        with patch.object(devices.time,'time',return_value=devices.time.time()+61):
            repeat=self.poll(self.one);self.assertEqual(repeat['occurrence'],2)
            devices.manage(self.root,{'action':'announcement-cancel','id':item['id']})
            self.assertIsNone(self.poll(self.one));self.ack(self.one,repeat)
        self.assertEqual(devices.listing(self.root)['announcements'][0]['shown'],1)
    def test_pending_activation_and_invalid_or_forged_requests(self):
        item=self.send(self.one['id']);devices.manage(self.root,{'action':'access','id':self.one['id'],'enabled':False})
        self.assertIsNone(self.poll(self.one))
        with self.assertRaises(PermissionError):self.ack(self.one,{'id':item['id'],'occurrence':1})
        devices.manage(self.root,{'action':'access','id':self.one['id'],'enabled':True})
        notice=self.poll(self.one);self.ack(self.one,{**notice,'occurrence':100})
        self.assertEqual(self.poll(self.one)['occurrence'],1)
        for repeats in [0,101,True]:
            with self.assertRaises(ValueError):self.send(repeats=repeats)
        with self.assertRaises(ValueError):self.send('missing')

if __name__=='__main__':unittest.main()

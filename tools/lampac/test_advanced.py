import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
import advanced

class AdvancedTests(unittest.TestCase):
    def test_schema_hides_credentials_and_preserves_unrelated_fields(self):
        config={'listen':{'port':9118}, 'Rezka':{'enable':True,'plugin':'rezka','displayindex':1,'token':'private','host':'https://example.org','headers':{'Authorization':'private'}}}
        before=copy.deepcopy(config)
        fields=advanced.fields(config)
        self.assertNotIn('private',json.dumps(fields))
        updated=advanced.apply_fields(config,config,{'Rezka.enable':False,'Rezka.token':''})
        self.assertEqual(config,before)
        self.assertEqual(updated['Rezka']['token'],'private')
        self.assertEqual(updated['listen'],config['listen'])
        self.assertFalse(updated['Rezka']['enable'])
        for change in [{'listen.port':80},{'Rezka.enable':'false'},{'Rezka.host':'javascript:alert(1)'},{'Rezka.displayindex':True}]:
            with self.assertRaises(ValueError):advanced.apply_fields(config,config,change)

    def test_client_policy_preserves_plugins_and_validates_keys(self):
        config={'LampaWeb':{'customPlugins':[{'url':'https://example.org/p.js','author':'other','status':1}]},'token':'keep'}
        updated=advanced.apply_client(config,config,{'mode':'revision','values':{'screensaver':'false','source':'tmdb'}},'https://lc.example.org')
        self.assertEqual(updated['LampaWeb']['customPlugins'][0],config['LampaWeb']['customPlugins'][0])
        self.assertEqual(updated['token'],'keep')
        self.assertNotIn('keep',advanced.client_script(updated))
        self.assertEqual(len(advanced.apply_client(updated,updated,{'mode':'disabled','values':{}},'https://lc.example.org')['LampaWeb']['customPlugins']),2)
        for value in [{'source':'bad'},{'screensaver':False},{'token':'secret'}]:
            with self.assertRaises(ValueError):advanced.apply_client({}, {}, {'mode':'always','values':value},'https://x.org')

    def test_home_preferences_validate_and_keep_details_device_scoped(self):
        fields={f['key']:f for f in advanced.client_settings({})['fields']}
        self.assertTrue(fields['workspace_header_profile']['global'])
        self.assertFalse(fields['workspace_header_clock']['global'])
        self.assertEqual(fields['interface_size']['group'],'Главный экран')
        values={'workspace_header_profile':'false','interface_size':'bigger','poster_size':'w500'}
        self.assertEqual(advanced.apply_client({}, {}, {'mode':'always','values':values},'https://example.org')['WorkspaceUI']['values'],values)
        with self.assertRaises(ValueError):advanced.apply_client({}, {}, {'mode':'always','values':{'interface_size':'huge'}},'https://example.org')

    def test_torrent_actions_are_targeted_and_removal_verified(self):
        torrent={'hash':'a'*40,'title':'test','data':'secret','poster':'secret'}
        request=Mock(return_value=[torrent])
        self.assertNotIn('secret',json.dumps(advanced.torrents(request)))
        for body in [{'action':'wipe','hash':'a'*40},{'action':'rem','hash':'../data'},{'action':'add','hash':'a'*40}]:
            with self.assertRaises(ValueError):advanced.torrent_action(request,body)
        request=Mock(side_effect=[[torrent],{},[]])
        advanced.torrent_action(request,{'action':'rem','hash':'a'*40})
        self.assertEqual(request.call_args_list[1].args,({'action':'rem','hash':'a'*40},'/torrents'))
        with self.assertRaises(RuntimeError):advanced.torrent_action(Mock(return_value=[torrent]),{'action':'rem','hash':'a'*40})

    def test_ip_blocking_and_observations_do_not_store_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            self.assertTrue(advanced.access(root,'::ffff:203.0.113.4','browser','/ts/stream?link='+'a'*40+'&token=secret'))
            data=advanced.clients(root)
            self.assertEqual(data['clients'][0]['ip'],'203.0.113.4')
            self.assertEqual(data['clients'][0]['torrent'],'a'*40)
            self.assertNotIn('secret',json.dumps(data))
            advanced.block(root,{'ip':'203.0.113.4','blocked':True})
            self.assertFalse(advanced.access(root,'203.0.113.4','other browser','/ts/settings'))
            self.assertTrue(advanced.access(root,'203.0.113.5','browser','/ts/settings'))
            advanced.block(root,{'ip':'203.0.113.4','blocked':False})
            self.assertTrue(advanced.access(root,'203.0.113.4','browser','/'))
            for ip in ['127.0.0.1','::1','::ffff:127.0.0.1','1.2.3.4/24','1.2.3.4;id']:
                with self.assertRaises(ValueError):advanced.block(root,{'ip':ip,'blocked':True})

if __name__=='__main__':unittest.main()

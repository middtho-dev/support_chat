import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
import urllib.request
import urllib.error
import agent

class AgentTests(unittest.TestCase):
    def test_caddy_auth_accepts_asset_query_strings_without_bypassing_auth(self):
        server=agent.ThreadingHTTPServer(('127.0.0.1',0),agent.Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            with patch.object(agent,'TOKEN','test-token'),patch.object(agent.advanced,'access',return_value=True) as access:
                url='http://127.0.0.1:'+str(server.server_port)+'/access?v=1987573'
                for token,expected in [('',401),('test-token',200)]:
                    req=urllib.request.Request(url,headers={'x-admin-token':token,'X-Workspace-IP':'203.0.113.1','X-Workspace-URI':'//app.min.js?v=1987573'})
                    try:
                        with urllib.request.urlopen(req) as response:code=response.status
                    except urllib.error.HTTPError as error:code=error.code;error.close()
                    self.assertEqual(code,expected)
                access.assert_called_once_with(agent.ROOT,'203.0.113.1','','//app.min.js?v=1987573')
        finally:server.shutdown();server.server_close()

    def test_blocked_device_gets_activation_page_but_can_poll(self):
        server=agent.ThreadingHTTPServer(('127.0.0.1',0),agent.Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            with patch.object(agent,'TOKEN','test-token'),patch.object(agent.advanced,'access',return_value=True),patch.object(agent.devices,'access_allowed',return_value=False):
                url='http://127.0.0.1:'+str(server.server_port)+'/access'
                for path,expected in [('/',403),('/app.min.js',403),('/workspace-device/poll',200),('/workspace-client.js',200)]:
                    req=urllib.request.Request(url,headers={'x-admin-token':'test-token','X-Workspace-URI':path})
                    try:
                        with urllib.request.urlopen(req) as response:code=response.status;payload=response.read().decode()
                    except urllib.error.HTTPError as error:
                        code=error.code;payload=error.read().decode();error.close()
                    self.assertEqual(code,expected)
                    if path=='/':
                        self.assertIn('workspace-access-disabled',payload)
                        self.assertIn('/workspace-device/poll',payload)
                        self.assertIn('https://helpo.su/logo.png',payload)
        finally:server.shutdown();server.server_close()

    def test_bootstrap_preserves_page_and_is_idempotent(self):
        original='<html><HEAD><script src="/lampainit.js"></script></HEAD><body>Existing Lampa</body></html>'
        result=agent.bootstrap_page(original)
        self.assertIn('/workspace-bootstrap.js',result)
        self.assertIn('<body>Existing Lampa</body>',result)
        self.assertIn('<script src="/lampainit.js"></script>',result)
        self.assertEqual(result.count('id="workspace-bootstrap"'),1)
        self.assertEqual(agent.bootstrap_page(result),result)

    def values(self):
        return dict(name='My Lampac', lowMemory=True, chromium=False, timeout=20,
                    modules={key: key != 'DLNA' for key in agent.MODULES})

    def test_patch_preserves_unexposed_configuration(self):
        original={'listen': {'ip':'127.0.0.1','port':9118},'privateKey':'secret',
                  'BaseModule':{'SkipModules':['Custom','TorrServer'],'LoadModules':['.*']}}
        before=copy.deepcopy(original);result=agent.patch_config(original,self.values())
        self.assertEqual(original,before)
        self.assertEqual(result['BaseModule']['SkipModules'],['Custom','DLNA'])
        self.assertEqual(result['BaseModule']['LoadModules'],['.*'])
        self.assertEqual(result['listen']['port'],9118)
        self.assertEqual(result['privateKey'],'secret')
        self.assertNotIn('privateKey',agent.settings(result))

    def test_invalid_fields_cannot_select_paths_or_commands(self):
        for extra in [{'timeout':True},{'name':''},{'modules':{}},{'exec':'id'}]:
            with self.assertRaises(ValueError):agent.patch_config({},self.values()|extra)

    def test_atomic_config_write_has_backup(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(agent,'ROOT',Path(directory)):
            agent.save_config({'secret':'keep'})
            agent.save_config({'name':'changed'})
            self.assertEqual(agent.read_config('init.conf'),{'name':'changed'})
            backups=list((Path(directory)/'database/backup/workspace').glob('*.json'))
            self.assertEqual(json.loads(backups[0].read_text()),{'secret':'keep'})

    def test_torrserver_patch_preserves_unexposed_settings(self):
        values={k: bounds[0] for k,bounds in agent.TS_NUMBERS.items()}|{k:False for k in agent.TS_BOOLS}
        self.assertEqual(agent.torr_patch({'secret':'keep'},values)['secret'],'keep')
        with self.assertRaises(ValueError):agent.torr_patch({},values|{'CacheSize':-1})
        with self.assertRaises(ValueError):agent.torr_patch({},values|{'SslKey':'evil'})

    def test_http_auth_and_command_allowlist(self):
        server=agent.ThreadingHTTPServer(('127.0.0.1',0),agent.Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        url='http://127.0.0.1:'+str(server.server_port)+'/api/lampac/action'
        try:
            with patch.object(agent,'TOKEN','test-token'),patch.object(agent,'command') as command:
                for token,action,expected in [('', 'restart',401),('test-token','restart; id',400),('test-token','restart',200)]:
                    request=urllib.request.Request(url,data=json.dumps({'action':action}).encode(),headers={'x-admin-token':token})
                    try:code=urllib.request.urlopen(request).status
                    except urllib.error.HTTPError as e:code=e.code
                    self.assertEqual(code,expected)
                command.assert_called_once_with('/usr/bin/sudo','-n','/usr/bin/systemctl','restart','lampac.service')
        finally:server.shutdown();server.server_close()

    def test_restart_only_signals_torrserver_and_checks_new_process(self):
        with patch.object(agent,'torr_pids',side_effect=[[123],[456]]),patch.object(agent.os,'kill') as kill,patch.object(agent.time,'sleep'),patch.object(agent,'torr_request',return_value={}) as request:
            agent.restart_torrserver()
            kill.assert_called_once_with(123,agent.signal.SIGTERM)
            request.assert_called_once_with({'action':'get'})

    def test_noop_settings_do_not_reset_torrents(self):
        values={k: bounds[0] for k,bounds in agent.TS_NUMBERS.items()}|{k:False for k in agent.TS_BOOLS}
        server=agent.ThreadingHTTPServer(('127.0.0.1',0),agent.Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            with patch.object(agent,'TOKEN','test-token'),patch.object(agent,'torr_request',return_value=values) as request:
                req=urllib.request.Request('http://127.0.0.1:'+str(server.server_port)+'/api/lampac/torrserver',data=json.dumps(values).encode(),headers={'x-admin-token':'test-token'})
                self.assertTrue(json.load(urllib.request.urlopen(req))['unchanged'])
                request.assert_called_once_with({'action':'get'})
        finally:server.shutdown();server.server_close()

if __name__=='__main__':unittest.main()

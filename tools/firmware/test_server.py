import http.client as client
import json,tempfile,threading,unittest
from pathlib import Path
from unittest.mock import patch
import server
import test_firmware

class WorkerTests(unittest.TestCase):
    def test_auth_upload_quota_and_locked_delete(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(server,'ROOT',Path(directory)),patch.object(server,'TOKEN','test-only-token'),patch.object(server,'LOCK',threading.Lock()):
            server.cleanup()
            http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
            thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            def request(method,path,body=None,auth=True):
                connection=client.HTTPConnection('127.0.0.1',http.server_port)
                headers={'x-admin-token':'test-only-token'} if auth else {}
                if body is not None:headers['Content-Type']='application/octet-stream'
                connection.request(method,path,body,headers);response=connection.getresponse();status=response.status;data=json.loads(response.read());connection.close();return status,data
            try:
                self.assertEqual(request('GET','/',auth=False)[0],401)
                self.assertEqual(request('POST','/images',b'invalid')[0],400)
                data=test_firmware.FirmwareTests().image()
                code,item=request('POST','/images',data);self.assertEqual(code,201)
                self.assertEqual((Path(directory)/'images'/item['id']/'input.bin').read_bytes(),data)
                self.assertEqual(request('POST','/images',data)[0],201)
                self.assertEqual(request('POST','/images',data)[0],400)
                server.LOCK.acquire()
                self.assertEqual(request('DELETE','/images/'+item['id'])[0],409)
                server.LOCK.release()
                self.assertEqual(request('DELETE','/images/'+item['id'])[0],200)
                self.assertEqual(len(request('GET','/')[1]['images']),1)
            finally:http.shutdown();http.server_close();thread.join()

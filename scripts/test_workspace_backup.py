import importlib.util,json,pathlib,sqlite3,tempfile,unittest,os
spec=importlib.util.spec_from_file_location('backup',pathlib.Path(__file__).with_name('workspace-backup.py'));backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)
class BackupTests(unittest.TestCase):
 def test_snapshot_deduplicates_restores_and_checks_live_wal_database(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);data=root/'data';data.mkdir();(data/'config.env').write_text('TOKEN=fixture-only');(data/'copy.env').write_text('TOKEN=fixture-only')
   db=sqlite3.connect(data/'support.db');db.execute('PRAGMA journal_mode=WAL');db.execute('CREATE TABLE sample (value TEXT)');db.execute("INSERT INTO sample VALUES ('retained')");db.commit()
   try:
    dest=root/'backups';name,manifest=backup.snapshot(dest,{'support':data});self.assertEqual(len(manifest['files']),3);self.assertEqual(manifest['uniqueObjects'],2)
    self.assertEqual(backup.verify(dest,manifest),2);self.assertEqual(backup.restore(dest,manifest,root/'restored'),3)
    with sqlite3.connect(root/'restored/support/support.db') as copied:self.assertEqual(copied.execute('SELECT value FROM sample').fetchone()[0],'retained')
    _,second=backup.snapshot(dest,{'support':data});self.assertEqual(len(list((dest/'objects').iterdir())),2)
    self.assertEqual(os.stat(dest).st_mode&0o777,0o700);self.assertEqual(os.stat(root/'restored/support/config.env').st_mode&0o777,0o600)
   finally:db.close()
 def test_retention_and_corruption(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);file=root/'source';file.write_text('old');dest=root/'backup';backup.snapshot(dest,{'data':file},retain=1);file.write_text('new');_,manifest=backup.snapshot(dest,{'data':file},retain=1)
   self.assertEqual(len(list((dest/'snapshots').glob('*.json'))),1);self.assertEqual(len(list((dest/'objects').iterdir())),1)
   (dest/'objects'/manifest['files'][0]['sha256']).write_text('bad')
   with self.assertRaises(ValueError):backup.verify(dest,manifest)
 def test_restore_refuses_nonempty_and_production_paths(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);file=root/'source';file.write_text('data');dest=root/'backup';_,manifest=backup.snapshot(dest,{'data':file});target=root/'occupied';target.mkdir();(target/'keep').write_text('keep')
   for p in [target,pathlib.Path('/root/support_chat'),pathlib.Path('/var/lib/docker/volumes/restore')]:
    with self.assertRaises(ValueError):backup.restore(dest,manifest,p)
   self.assertEqual((target/'keep').read_text(),'keep')
 def test_symlinks_and_generated_media_are_not_copied(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);source=root/'data';source.mkdir();(source/'state.json').write_text('{}');(source/'escape').symlink_to('/etc/passwd');(source/'files').mkdir();(source/'files/media.mp4').write_bytes(b'media')
   _,manifest=backup.snapshot(root/'backup',{'video':source});self.assertEqual([x['path'] for x in manifest['files']],['video/state.json'])
if __name__=='__main__':unittest.main()

// The +3's disk drive: a program saved from +3 BASIC onto a blank disk, then started from
// the disk by the menu's Loader, as the autostart does.
import { makeMachine, screenText, runUntilText, makeChecker } from './util.mjs';
import { DskImage } from '../../web/js/emu/dsk.js';
import { planAutostart } from '../../web/js/emu/autostart.js';
import { detectType } from '../../web/js/emu/media.js';

const { check, done } = makeChecker();

const disk = DskImage.blank('plus3');
check('a blank +3 disk', disk.format() === 'plus3');

{
  const m = makeMachine({ model: 'plus3' });
  m.insertDisk(disk);
  m.typeKeys('DOWN');
  m.typeKeys('ENTER');
  m.typeWait(30);
  m.typeText('10 print "FROM DISK"\r');
  m.typeText('20 go to 20\r');
  m.typeText('save "DISK" line 10\r');
  for (let i = 0; i < 50 * 25 && !(m.typeQueue.length === 0 && disk.listFiles().length); i++) m.runFrame();
  for (let i = 0; i < 100; i++) m.runFrame();
  const files = disk.listFiles();
  check('+3 BASIC saved DISK', files.some((f) => f.name === 'DISK'), JSON.stringify(files) + ' ' + screenText(m).join('|'));
}

{
  const copy = DskImage.parse(disk.toBytes());
  check('the disk image is a .dsk', detectType('x.dsk', disk.toBytes()) === 'disk');
  const m = makeMachine({ model: 'plus3' });
  m.insertDisk(copy);
  planAutostart(m, { disk: copy }, {});
  check('Loader runs DISK from the disk', runUntilText(m, 'FROM DISK', 20), screenText(m).join('|'));
}

done();

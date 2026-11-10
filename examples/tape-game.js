// A tape game (.tap or .tzx) on a 48K: ZXEmu types LOAD "" and the ROM's blocks load at once.
export default {
  ui: { title: 'Cave Run' },
  model: '48k',
  media: { tape: 'games/caverun.tzx' },
};

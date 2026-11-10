// A locked-down page for players: pause, joystick, save states, CRT, sound and fullscreen only.
export default {
  ui: { title: 'Space Blaster', minimal: true, touchKeys: ['ENTER', 'SPACE'] },
  media: { tape: 'games/spaceblaster.tzx' },
  video: { crt: true, filter: true },
};

// A game that reads a Sinclair joystick, with its own keyboard joystick keys.
export default {
  ui: { title: 'Racer' },
  model: '48k',
  media: { tape: 'games/racer.tzx' },
  joystick: {
    type: 'sinclair1',
    keyboard: true,
    keys: {
      up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
      fire: ['Space', 'KeyJ'],
    },
  },
};

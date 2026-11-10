// A machine code file: put in memory at `load` once the ROM is ready, and started at `exec`.
export default {
  ui: { title: 'Maze' },
  model: '48k',
  media: { bin: { url: 'games/maze.bin', load: '&8000', exec: '&8000' } },
};

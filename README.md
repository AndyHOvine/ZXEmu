# ZXEmu

A ZX Spectrum emulator in plain JavaScript for the web browser, made for publishing
Spectrum games on itch.io. The published game has no dependencies and needs no server
code: it is a folder of static files.

- ZX Spectrum 16K, 48K, 128K, +2, +2A and +3, with their ROMs included
- A Z80 written for ZXEmu: exact T-states, every undocumented opcode and flag (it passes
  ZEXALL and all of Patrik Rak's z80test, MEMPTR and SCF/CCF included), and the ULA's
  memory and I/O contention, cycle by cycle, on each model
- The picture drawn as the beam reaches it: multicolour, border effects and the floating
  bus work; FLASH, bright, the 128K's second screen
- The beeper, and the AY-3-8912 of the 128K models in stereo (ABC, ACB or mono)
- Joystick interfaces: Kempston, cursor (Protek, AGF), Sinclair 1 and 2, Fuller
- Tapes (`.tap`, `.tzx`, `.csw`, `.wav`) loaded as real edges, so turbo loaders work, or
  at once (fast loading) when the ROM loads a block; SAVE onto a tape you can download
- Snapshots (`.z80` versions 1 to 3, `.sna` 48K and 128K), saved as `.z80` too; +3 disks
  (`.dsk`, read and write, drives A and B); Interface 2 cartridges (`.rom`); binaries
  (`.bin`, `.scr`); ZIP files
- Starts games by itself: `LOAD ""` on a 48K, the menu's Tape Loader or Loader on the others
- CRT emulation and CRT filter (bulge, rounded corners, scanlines, RGB mask, tint)
- Standard, vivid, black and white TV and green screen palettes
- Keyboard joystick (switch with F9), gamepads, touch controls on phones
- Save states: four save and load slots per game, kept in the player's browser

---

## 1. Set up

1. Install **Node.js 18 or newer** from https://nodejs.org/ (the LTS version is fine).
   Check it in a terminal:
   ```
   node --version
   ```
2. Open a terminal in the project folder (the one with `run.bat` in it).
3. Linux and macOS only, once: make the scripts runnable.
   ```
   chmod +x run.sh build.sh
   ```

Nothing else needs installing.

---

## 2. Running

Start ZXEmu in your browser:

| | Windows | Linux / macOS |
| --- | --- | --- |
| Start in BASIC | `run.bat` | `./run.sh` |
| Load a game | `run.bat C:\games\mygame.tzx` | `./run.sh ~/games/mygame.tzx` |
| Load with settings | `run.bat mygame.tap model=128k joystick=cursor` | `./run.sh mygame.tap model=128k joystick=cursor` |

The game file can be anywhere on your disk: TAP, TZX, CSW, WAV, Z80, SNA, DSK, ROM, BIN,
SCR or a ZIP. Its type is worked out from its contents. The browser opens on its own;
press **Ctrl+C** in the terminal to stop.

Settings you can add after the file:

| Setting | Example | Meaning |
| --- | --- | --- |
| `model` | `model=128k` | `16k`, `48k`, `128k`, `plus2`, `plus2a`, `plus3` or `auto` |
| `joystick` | `joystick=cursor` | the joystick interface: `kempston`, `cursor`, `sinclair1`, `sinclair2`, `fuller` or `none` |
| `flashload` | `flashload=0` | fast tape loading on (`1`) or off (`0`: every tape plays in real time) |
| `load`, `exec` | `load=&8000` | addresses for a `.bin` |
| `joykeys` | `joykeys=0` | keyboard joystick on (`1`) or off (`0`) at start |
| `crt` / `filter` | `crt=0 filter=0` | CRT emulation / CRT filter on or off |
| `palette` | `palette=green` | `standard`, `vivid`, `grey`, `green` |
| `border` | `border=none` | `normal`, `full`, `tight` or `none` |
| `stereo` | `stereo=acb` | the AY's channels: `abc`, `acb` or `mono` |
| `autostart` | `autostart=0` | `1`, `0`, or text to type |
| `title` | `title="My Game"` | name on the start screen |
| `minimal` | `minimal=1` | minimal toolbar (see below) |
| `touchkeys` | `touchkeys=ENTER,SPACE,Y,N` | Spectrum keys shown as buttons on phones and tablets, or `none` (see *On-screen keys*) |
| `touchstick` | `touchstick=left,right` | directions the touch stick gives, or `none` for no stick |
| `touchfire` | `touchfire=up:JUMP,fire:DASH` | the touch fire buttons, each with an optional label, or `none` |
| `touchslide` | `touchslide=1` | a finger sliding onto the touch stick or a fire button takes it |

You can also drag a file onto the emulator, or use the folder button in the toolbar.
Hold **Shift** while clicking the folder button (or while dropping a file) to attach it
without running it: ZXEmu stops in BASIC (or at the menu) with the tape in or the disk in
the drive, so you can type `LOAD ""` or `CAT` yourself. Snapshots and cartridges always
start by themselves.

**Save and load.** The floppy disk button in the toolbar opens four save slots. The game
pauses while they are open; each slot shows a picture of the screen and when it was
saved. **Shift+F9** saves and **Shift+F10** loads the last slot used, without opening the
slots. Saves are kept in the browser (IndexedDB), separately for each game: a game is
recognised by the contents of its files, so it keeps its slots after an update only if
the files are unchanged. A save holds the whole machine, including the disks' contents
and the tape position. **Save snapshot (.z80)** in the settings panel downloads the
machine as a file instead.

To run the tests: `npm test`.

---

## 3. Building

Building makes a folder and a ZIP in `dist/`, ready to upload.

| What | Windows | Linux / macOS |
| --- | --- | --- |
| Package as set up in `web/config.js` | `build.bat` | `./build.sh` |
| Package one game file | `build.bat C:\games\mygame.tzx title="My Game"` | `./build.sh ~/games/mygame.tzx title="My Game"` |
| Choose the package name | `build.bat mygame.tzx --name mygame` | `./build.sh mygame.tzx --name mygame` |
| ROMs for every model | add `--all-roms` | add `--all-roms` |

Examples:

```
build.bat
build.bat C:\games\mygame.tzx title="My Game" model=128k
./build.sh ~/games/mygame.tap joystick=sinclair1 joykeys=1
./build.sh ~/games/mygame.bin load=&8000 exec=&8000
```

The result is `dist/<name>/` and `dist/<name>-itch.zip`. When you give a game file, it is
copied into the package and set up to start automatically; the settings are the same as
for running. Without a file, the package uses `web/config.js` and whatever you put in
`web/games/`, with any settings you give applied on top. A file in `web/games/` is only
loaded if `web/config.js` names it in `media` (the build warns if it doesn't).

**ROMs in the package.** A package only holds the ROM its game needs: `48.rom` for the 16K
and 48K, `128.rom`, `plus2.rom`, or `plus3.rom` for the +2A and +3. An Interface 2
cartridge needs none. The build prints which ROM it included. Players can only pick
models in the settings panel whose ROMs are in the package; `--all-roms` includes them
all, so every model is offered.

To try a built package before uploading:

```
node tools/serve.mjs --root dist/mygame --open
```

---

## 4. Setting up a game

For a quick package, `build.bat mygame.tzx title="My Game"` is enough. For full control,
put your game files in `web/games/` and edit `web/config.js`. Then `run.bat` shows it and
`build.bat` packages it.

The [`examples/`](examples/README.md) folder has each config below as a file ready to copy
over `web/config.js`, plus one with every option.

Paths in the config are relative to `index.html`, so they all start with `games/`.

### A tape game

```js
export default {
  ui: { title: 'Cave Run' },
  model: '48k',
  media: { tape: 'games/caverun.tzx' },
};
```

On a 48K or 16K, ZXEmu types `LOAD ""` (J, then Symbol Shift + P twice) and ENTER. On the
others it chooses the menu's first entry: Tape Loader on the 128K and +2, Loader on the
+2A and +3.

With fast loading on (`flashLoad: true`, the default), every block the ROM loads arrives
at once. A block in any other form (a turbo loader, a recording) plays in real time, at
full speed while it does (auto warp), and the tape starts and stops by itself when a
program's own loader reads it, as Fuse does: its edge-timing loop is recognised. With
`flashLoad: false` the whole tape plays in real time, with the loading noise.

### A 128K game

```js
export default {
  ui: { title: 'Sea Song' },
  model: '128k',
  media: { tape: 'games/seasong.tap' },
};
```

`'plus2'` is the grey +2 (the same machine with Amstrad's ROM), `'plus2a'` the black +2A.

### A +3 disk

```js
export default {
  ui: { title: 'Dungeon' },
  media: { disk: 'games/dungeon.dsk' },
};
```

A disk picks the +3 by itself. ZXEmu chooses Loader at the menu, which starts the disk's
`DISK` program (or its boot sector). Players can download the disk, with what the game
saved on it, from the settings panel.

### An Interface 2 cartridge

```js
export default {
  ui: { title: 'Planetoids' },
  media: { cart: 'games/planetoids.rom' },
};
```

The cartridge takes the place of the ROM on a 48K, so the package needs no ROM.

### A machine code program

```js
export default {
  ui: { title: 'Maze' },
  media: { bin: { url: 'games/maze.bin', load: '&8000', exec: '&8000' } },
};
```

The program is put in memory once the ROM is ready and started at `exec`. A `.scr` (6912
bytes) goes on the screen and isn't run. Addresses may be written `&8000`, `$8000`,
`#8000`, `0x8000` or `32768`.

### A snapshot

```js
export default {
  media: { snapshot: 'games/maze.z80' },
};
```

The model comes from the snapshot unless you set `model`.

### A game with its own keys and joystick

```js
export default {
  ui: { title: 'Racer' },
  model: '48k',
  media: { tape: 'games/racer.tzx' },
  joystick: {
    type: 'sinclair1',   // the interface the game reads
    keyboard: true,
    // A primary and a secondary key for each direction
    keys: {
      up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
      fire: ['Space', 'KeyJ'],
    },
  },
};
```

`joystick.type` chooses the interface the PC's joystick (keyboard joystick, gamepad, touch
stick) is plugged into: `'kempston'` (port 31), `'cursor'` (Protek and AGF: 5, 6, 7, 8 and
0), `'sinclair1'` (6, 7, 8, 9 and 0), `'sinclair2'` (1, 2, 3, 4 and 5), `'fuller'` (port
127) or `'none'`. The Kempston interface reads 0 when nothing is pressed; with another
interface, port 31 gives the floating bus, as on a Spectrum without one. Players can
change it in the settings panel.

Key names are browser key codes: `KeyA`–`KeyZ`, `Digit0`–`Digit9`, `ArrowUp`, `Space`,
`ShiftLeft`, `ControlRight` and so on. Give one key, or a list: the first is the primary
key and the second the secondary key that players see in the settings panel (any more
also work).

### A locked-down page for players

```js
export default {
  ui: { title: 'Space Blaster', minimal: true },  // pause, joystick, save states, CRT, sound, fullscreen
  media: { tape: 'games/spaceblaster.tzx' },
};
```

The minimal view keeps pause, the keyboard joystick switch, save states, the CRT on/off
button, sound and fullscreen. It hides reset, warp, load, unload and settings, and turns
their hotkeys and drag-and-drop off.

### On-screen keys for phones and tablets

On touch screens, ZXEmu shows a joystick, a fire button and a row of Spectrum keys.
Choose the keys your game needs with `ui.touchKeys`:

```js
export default {
  ui: {
    title: 'Space Blaster',
    touchKeys: [
      'ENTER', 'SPACE', 'Y', 'N',                    // Spectrum key names
      { key: 'M', label: 'MUSIC' },                  // your own label on the button
      { keys: ['CAPS', 'SPACE'], label: 'QUIT' },    // keys pressed together
    ],
  },
  media: { tape: 'games/spaceblaster.tzx' },
};
```

With the build: `build.bat mygame.tzx touchkeys=ENTER,SPACE,Y,N`. Use `touchKeys: []` (or
`touchkeys=none`) for no keys, only the joystick and fire button. Set
`ui.touchControls: true` to show them on computers too, which helps when trying the
layout.

Key names: `A`–`Z`, `0`–`9`, `SPACE`, `ENTER`, `CAPS` (CAPS SHIFT), `SYMBOL` (SYMBOL
SHIFT), and keys that are two at once: `DELETE`, `BREAK`, `EDIT`, `UP`, `DOWN`, `LEFT`,
`RIGHT` (CAPS SHIFT + 7, 6, 5, 8), `CAPSLOCK`, `GRAPH`, `EXTEND`, `TRUEVIDEO`, `INVVIDEO`.
A name the emulator does not know is left out, with a warning in the browser console
(the build stops on one).

### Touch joystick and fire buttons

`ui.touchStick` chooses the directions the touch stick gives. A direction left out is
never sent. When both directions of an axis are left out, that axis is ignored, so a left
and right stick gives left or right wherever it is pushed. `[]` removes the stick.

`ui.touchFire` lists the round buttons beside the right thumb. Each one gives a joystick
input (`'fire'`, `'up'`, `'down'`, `'left'` or `'right'`) or holds Spectrum keys down, and
can have its own label. For a platform game where up jumps:

```js
export default {
  ui: {
    title: 'Cave Hopper',
    touchStick: ['left', 'right'],
    touchFire: [
      { joy: 'fire', label: 'DASH' },
      { joy: 'up', label: 'JUMP' },
      { key: 'SPACE', label: 'BOMB' },
    ],
    touchKeys: [],
  },
  media: { tape: 'games/cavehopper.tzx' },
};
```

Each entry is `{ joy, label }` for a joystick input, `{ key, label }` for a Spectrum key,
or `{ keys: [...], label }` for keys pressed together. A button can also be written as a
string: `'fire'`, `'up:JUMP'`, `'SPACE:BOMB'`. A joystick name comes before a key name, so
`'up'` is joystick up; use `{ key: 'UP' }` for the cursor key. The first button is at the
bottom right, and the buttons fill to the left and upwards from there. The default is one
`FIRE` button. `[]` removes them.

With the build: `build.bat mygame.tzx touchstick=left,right touchfire=fire:DASH,up:JUMP`.

### Sliding onto the controls, and moving them

With `ui.touchSlide: true`, a finger that slides onto the stick or a fire button takes it,
as if it had landed there, so a thumb can roll from one button to the next. A finger
between two buttons presses both. Sliding off a button lets it go. Without slide (the
default), a finger keeps whatever it landed on until it lifts. With the build:
`touchslide=1`.

On touch screens the toolbar has two more buttons:

- **Slide** switches sliding on and off for the player. The game's setting is the starting
  point; the player's choice is remembered in their browser.
- **Move** lets the player drag the stick and each fire button to where their thumbs want
  them. The game pauses until they tap **Done**; **Reset** puts the controls back.
  Portrait and landscape are set up separately, and the layout is remembered in the
  player's browser for that game.

### Plain pixels, no CRT

```js
export default {
  media: { tape: 'games/maze.tap' },
  video: { crt: false, filter: false, integerScale: true, aspect: 'square' },
};
```

### No border

```js
export default {
  media: { tape: 'games/spaceblaster.tzx' },
  video: { border: 'none' },
};
```

Only the 256 x 192 paper is shown; anything a game draws in the border is cut off.

---

## 5. Publishing on itch.io

1. **Build the package.**
   ```
   build.bat C:\games\mygame.tzx title="My Game"
   ```
   or, if you set the game up in `web/config.js`:
   ```
   build.bat --name mygame
   ```
   You get `dist\mygame-itch.zip`.
2. **Check it** (optional but worth it):
   ```
   node tools/serve.mjs --root dist/mygame --open
   ```
3. **Create the project** on https://itch.io/game/new:
   - **Kind of project**: **HTML**.
   - **Uploads**: upload the ZIP and tick **This file will be played in the browser**.
4. **Embed options** (further down the same page):
   - **Viewport dimensions**: **960 × 776** fits the picture plus the toolbar (any size
     works; the picture scales to fit).
   - Tick **Fullscreen button**.
   - Tick **Mobile friendly** if you want phone players; touch controls appear on their own.
   - Leave **SharedArrayBuffer support** off; ZXEmu doesn't need it.
5. **Save** and use **View page** to try it. Players click *Click to start*; this is needed
   for sound and keyboard focus.

To update the game later, build again and replace the ZIP on the same itch.io page.

**What players' browsers remember.** When a player turns the CRT or the keyboard joystick
on or off, changes display settings, volume, the AY's stereo or keyboard mapping, ZXEmu
remembers it. itch.io serves every HTML game from the same address, so these choices
follow the player to your other ZXEmu games too. A player's choice overrides your config,
but only for the settings they actually changed. Joystick keys, the joystick interface and
fast loading are remembered per game. Set `persistShared: false` to keep a game's choices
to itself, or `persist: false` to remember nothing. Save states are kept per game whatever
these settings are; `ui.saveStates: false` turns them off.

---

## Reference

### All config options

| Option | Values | Default |
| --- | --- | --- |
| `model` | `'auto'`, `'16k'`, `'48k'`, `'128k'`, `'plus2'`, `'plus2a'`, `'plus3'` | `'auto'` (a 48K; the snapshot's model; a +3 for a disk) |
| `media.tape` | URL of a `.tap`, `.tzx`, `.csw` or `.wav` (or `.zip`) | |
| `media.snapshot` | URL of a `.z80` or `.sna` | |
| `media.disk`, `media.diskB` | URL of a +3 `.dsk` for drive A or B | |
| `media.cart` | URL of an Interface 2 `.rom` | |
| `media.bin` | `{ url, load, exec }` for a binary; a `.scr` needs no addresses | |
| `media.file` | URL of any supported file; the type is detected | |
| `autostart` | `true`, `false`, or text to type, e.g. `'RUN\r'` | `true` |
| `type` | extra text typed once BASIC is ready, after autostart | `''` |
| `flashLoad` | load the ROM's tape blocks at once | `true` |
| `warp.auto` | full speed while a tape plays, the disk is busy, or text is typed | `true` |
| `joystick.type` | `'kempston'`, `'cursor'`, `'sinclair1'`, `'sinclair2'`, `'fuller'`, `'none'` | `'kempston'` |
| `joystick.keyboard` | start with the keyboard joystick on | `true` |
| `joystick.keys` | `{ up, down, left, right, fire, fire2 }`: one key code or a list per direction (first = primary, second = secondary) | cursor keys and numpad; fire = Left Ctrl, Right Ctrl, Numpad 0 |
| `joystick.buttons` | gamepad button to Spectrum key, e.g. `{ 9: 'ENTER', 8: 'SPACE' }` | `{}` |
| `keyboardMap` | `'symbolic'` (type what you see) or `'positional'` | `'symbolic'` |
| `video.crt` | `true`, `false`, or CRT emulation settings | `true` |
| `video.filter` | `true`, `false`, or CRT filter settings | `true` |
| `video.palette` | `'standard'`, `'vivid'`, `'grey'`, `'green'` | `'standard'` |
| `video.border` | `'normal'`, `'full'`, `'tight'` (a thin border), `'none'` (the paper only) | `'normal'` |
| `video.aspect` | `'tv'` (a PAL TV's shape) or `'square'` (square pixels) | `'tv'` |
| `video.integerScale` | `true`, `false` | `false` |
| `audio.volume` | 0 to 1 | `0.7` |
| `audio.stereo` | the AY's channels: `'abc'` (A left, B centre, C right), `'acb'`, `'mono'` | `'abc'` |
| `ui.title` | name on the start screen and toolbar | `'ZX Spectrum'` |
| `ui.minimal` | minimal toolbar: pause, keyboard joystick, save states, CRT, sound, fullscreen only | `false` |
| `ui.saveStates` | the save and load slots and their hotkeys | `true` |
| `ui.toolbar`, `ui.settings` | show the toolbar / the settings panel | `true` |
| `ui.clickToStart` | show the start screen (needed for sound) | `true` |
| `ui.touchControls` | `'auto'`, `true`, `false` | `'auto'` |
| `ui.touchKeys` | Spectrum keys shown as touch buttons: key names, `{ key, label }` or `{ keys: [...], label }` | ENTER SPACE Y N 1 2 CAPS SYMBOL |
| `ui.touchStick` | directions the touch stick gives; `[]` for no stick | `['up', 'down', 'left', 'right']` |
| `ui.touchFire` | touch fire buttons: `'fire'`, a direction or a Spectrum key, as `'name:label'`, `{ joy, label }`, `{ key, label }` or `{ keys: [...], label }` | `['fire']` |
| `ui.touchSlide` | a finger sliding onto the touch stick or a fire button takes it | `false` |
| `ui.allowFileDrop` | let players load their own files | `true` |
| `hotkeys` | `{ joystickToggle: 'F9', warp: 'F10', fullscreen: 'F11', reset: '', saveState: 'Shift+F9', loadState: 'Shift+F10' }`. A key code, optionally after `Shift+`; `''` turns a hotkey off | |
| `persist` | remember each player's choices in their browser | `true` |
| `persistShared` | share those choices with every page that uses ZXEmu on the same site | `true` |
| `urlParams` | allow `?tape=` style overrides in the page address | `true` |
| `romPath` | folder of the ROM files | `'roms/'` |
| `romsIncluded` | ROM files in the package; written by the build | `null` (all) |

**CRT emulation settings** (`video.crt`) and defaults: `blur` 100, `scanlineShade` 800,
`saturation`, `contrast`, `brightness`, `tint` 1000 (neutral), `gamma` 2200,
`oddLinesPhase` and `oddLinesOffset` 1125.

**CRT filter settings** (`video.filter`) and defaults: `scale` 1, `everyNLines` 4,
`linesDarkened` 3, `darkness` 10, `direction` `'rows'` (or `'columns'`), `bulge` 8,
`corners` 17, `cornerDot` 2, `bleed` 12, `glow` 5, `mask` 3, `maskShape` `'dots'` (or
`'stripes'`, `'stripes-gaps'`, `'slots'`), `maskWidth` 3, `tintColor` `'#ffb000'`, `tint`
6, `roll` -1, `rollingBar` 0. Percentages are 0–100.

**Page address overrides** (handy while testing):
`index.html?tape=games/x.tzx&model=128k&joystick=cursor&flashload=0&crt=0`

### Controls

| PC | Spectrum |
| --- | --- |
| Shift | CAPS SHIFT |
| Ctrl, Alt | SYMBOL SHIFT (Ctrl is joystick fire while the keyboard joystick is on) |
| Enter | ENTER |
| Backspace, Delete | DELETE (CAPS SHIFT + 0) |
| Esc | BREAK (CAPS SHIFT + SPACE) |
| Cursor keys | CAPS SHIFT + 5, 6, 7, 8 (the joystick while the keyboard joystick is on) |
| Tab | EXTEND MODE (CAPS SHIFT + SYMBOL SHIFT) |
| Caps Lock, Home, End | CAPS LOCK, EDIT, GRAPH |
| Numeric keypad | 0–9 (the joystick while the keyboard joystick is on) |
| F9 | keyboard joystick on or off |
| F10 | warp |
| F11 | fullscreen |
| Shift+F9 / Shift+F10 | save / load the last save slot used |

Typing is symbolic: what is printed on your key is what the Spectrum types, so `"` is
SYMBOL SHIFT + P whatever your keyboard needs for it. On a 48K, BASIC's keywords are
single keys (P is PRINT at the start of a line), as on the real machine; the 128K and
later models' editors take words typed letter by letter. Paste text (Ctrl+V) to type it.
Gamepads work automatically: stick or d-pad to move, face buttons for fire.

Players can change the joystick keys in the settings panel. Each direction and fire has a
primary and a secondary key: click one, then press the key to use (Backspace clears it,
Esc cancels). The eject button removes the loaded game and restarts in BASIC.

### Using ZXEmu from your own page

```js
import { ZXEmu } from './js/zxemu.js';
const zx = await ZXEmu.create(document.getElementById('zxemu'), options);
zx.reset();               // restart the program
zx.resetToBasic();
zx.unload();              // remove all media and start in BASIC
zx.setJoystickKeys(true);
zx.setJoystickType('cursor');
zx.setModel('128k');
zx.typeText('print 1\r');
await zx.saveState(1);    // slot 1 to 4
await zx.loadState(1);
zx.snapshot();            // the machine as a .z80 file (Uint8Array)
zx.machine;               // the emulated Spectrum, for poking at memory
```

### The machine without a page (Node)

`web/js/emu/spectrum.js` needs no browser, so tools and tests can run a Spectrum:

```js
import { Spectrum } from './web/js/emu/spectrum.js';
const m = new Spectrum({ roms: { rom48, rom128, plus2, plus3 }, model: '48k' });
m.onReady(() => m.injectBinary(code, 0x8000, 0x8000));
m.runFrame();             // one frame: 69888 T-states on a 48K, 70908 on the others
m.setJoystick(1 | 16);    // up and fire (bits: 1 up, 2 down, 4 left, 8 right, 16 fire)
m.peek(0x5800);           // memory as the CPU sees it now
m.video.fb;               // the picture: 704 x 288 RGBA words, each Spectrum pixel two wide
```

`m.cpu.trapFlags` and `m.cpu.onTrap(pc)` (true skips the instruction) let a debugger stop
at addresses, as in AmsEmu. ZXEmu uses them itself for fast loading (LD-BYTES, `$0556`)
and for SAVE (SA-BYTES, `$04C2`) when the 48K BASIC ROM is paged in.

### Testing

`npm test` runs the tests in `tools/test`: the Z80's timings and Patrik Rak's z80test
(all flags, MEMPTR, SCF/CCF, in `tools/test/z80test`, MIT licence) loaded from tape on a
48K; every model starting and running programs under IM 2; the joystick interfaces;
tapes loaded at once and as edges, TZX blocks, recordings; snapshots; the beeper and the
AY; the +3's disk; and the page in a headless Chrome or Edge, when one is found.

`tools/dev/zex.mjs` runs Frank Cringle's ZEXDOC or ZEXALL (not included: get
`zexall.com` yourself) on the Z80 alone: `node tools/dev/zex.mjs zexall.com`. ZXEmu's Z80
passes both.

---

## Licences and ROMs

- ZXEmu is under the GNU General Public License, version 2 or (at your option) any later
  version. See `LICENSE`.
- The Z80, the ULA, the sound, the tapes and the snapshots were written for ZXEmu. The
  +3's disk controller and disk images (`web/js/emu/fdc.js`, `dsk.js`) are AmsEmu's, which
  are a JavaScript port of parts of Caprice32, GPL v2 or later.
- The CRT emulation, CRT filter and the browser front end come from AmsEmu, by HEWCO.
- `tools/test/z80test` holds Patrik Rak's z80test tapes, under the MIT licence
  (`tools/test/z80test/license.txt`).
- `web/roms/` holds the ZX Spectrum 48K, 128K, +2 and +3 ROMs:

  | File | Size | ROM | SHA-1 |
  | --- | --- | --- | --- |
  | `48.rom` | 16 KB | 16K and 48K BASIC | `5ea7c2b824672e914525d1d5c419d71b84a426a2` |
  | `128.rom` | 32 KB | 128K editor and 48K BASIC | `16375d42ea109b47edded7a16028de7fdb3013a1` |
  | `plus2.rom` | 32 KB | +2 editor and 48K BASIC | `8cafb292af58617907b9e6b9093d3588a75849b8` |
  | `plus3.rom` | 64 KB | +2A and +3 (+3DOS) | `500c0945760abeefcbd08bc22c0d07b14b336cf0` |

  The Spectrum ROMs are copyright Amstrad, which bought Sinclair's computers in 1986.
  Amstrad allows them to be distributed with emulators, on condition that its copyright
  is acknowledged and that they are not sold, and asks for this acknowledgement:
  Amstrad have kindly given their permission for the redistribution of their copyrighted
  material but retain that copyright.

# ZX Spectrum Next video hardware reference (for an emulator)

Source: SpectrumNext/ZX_Spectrum_Next_FPGA master (shallow clone), `cores/zxnext/src`. Files are cited as `zxnext:NNNN`, `l2:NN` (video/layer2.vhd), `tm:NN` (tilemap.vhd), `spr:NN` (sprites.vhd), `ula:NN` (zxula.vhd), `tim:NN` (zxula_timing.vhd) and `lores:NN`. `nextreg.txt` and `ports.txt` in `cores/zxnext/` are the official register docs.
**[UNCONFIRMED]** marks anything not taken from the VHDL.

Colour notation: 9-bit colour = `R2R1R0 G2G1G0 B2B1B0` (bit 8..0). 8-bit colour = `RRRGGGBB` = bits 8:1 of the 9-bit colour.

---

## 1. Display geometry

Counters (tim:476-522):
- `vc`/`hc`: ULA counters. `vc=0` is the first paper line.
- `phc`: "practical" x. `phc=0` is paper pixel 0 (ULA `hc=0x0C`).
- `whc`/`wvc`: the 320x256 surface. `whc = phc + 32`, `wvc = vc + 32`.

| Area | x range (whc) | y range (wvc) |
|---|---|---|
| 320x256 surface (sprites, tilemap, L2 320/640) | 0-319 | 0-255 |
| ULA paper 256x192 (ULA, LoRes, L2 256x192) | 32-287 | 32-223 |
| Border inside the surface | the rest | the rest |

- 640-wide modes (L2 640x256, tilemap 80x32): 2 hi-res pixels per 320-coordinate pixel. They are output at 14 MHz: L2 at `sc(1)` (l2:202), tilemap at `hcount(10:1)` (tm:228).
- Timex hi-res: 512 pixels across the 256 paper, so also 2 per pixel.
- Sprites are 320-resolution only.
- Mixer resolution: ULA/tilemap pixels are produced at 14 MHz. L2/sprite pixels are produced at 7 MHz, except L2 640, which changes nibble each half pixel. An emulator can render a 640x256 framebuffer and double the lo-res layers.
- Frame line counts (`c_max_vc`) for reference: 48K 50Hz 312 lines, 128K/+3 50Hz 311, 60Hz 264, Pentagon 320. Line lengths: 448 (48K, Pentagon) or 456 (128K/+3) pixels.

---

## 2. Palettes

Eight palettes, each 256 x 9-bit plus 2 priority bits. There are two BRAMs (zxnext:6952-7053):
- ULA/Tilemap RAM. Address = `wsel(1) & wsel(2) & idx`: bit 9 0=ULA, 1=TM; bit 8 = second palette.
- Layer 2/Sprite RAM. Address bit 9 0=L2, 1=Sprites; bit 8 = second palette.

### NR $40 Palette index (R/W)
- Bits 7:0 = index. A write also resets the $44 byte phase to "first write" (zxnext:5374).

### NR $41 8-bit colour (R/W)
- Write: `colour9 = d<<1 | (d.1 | d.0)`, and the priority bits are cleared to 0 (zxnext:4919-4920).
- Then `idx++` if auto-increment is enabled. The $44 phase is reset.
- Read: `colour9[8:1]` of the selected palette and index. Reads do not increment.

### NR $42 ULANext ink mask (R/W)
- Reset `$07`. See §4.

### NR $43 Palette control (R/W). Any write resets the $44 phase.
| bit | meaning |
|---|---|
| 7 | 1 = disable auto-increment |
| 6:4 | read/write palette: 000 ULA1, 100 ULA2, 001 L2-1, 101 L2-2, 010 SPR1, 110 SPR2, 011 TM1, 111 TM2 |
| 3 | active sprite palette (0 first / 1 second) |
| 2 | active Layer 2 palette |
| 1 | active ULA palette (LoRes uses it too) |
| 0 | ULANext enable |

- The active tilemap palette is NR $6B bit 4, not $43.
- Reset value: all bits 0.

### NR $44 9-bit colour (R/W) (zxnext:5397-5403, 4918-4920)
```
1st write: stored = d                              ; nothing written yet
2nd write: colour9 = stored<<1 | d.0 ; prio[1:0] = d[7:6] ; idx++ if autoinc
phase toggles on every $44 write; writes to $40/$41/$43 reset it to the first write
```
- Read: `prio1 prio0 0 0 0 0 0 B0`, i.e. bit 7 = priority bit, bit 0 = blue LSB (zxnext:6048). Reads do not increment.
- Layer 2 priority: bit 7 of the 2nd write sets stored bit 15. In an **L2 palette** entry, this bit puts that L2 pixel above all layers (see §8).
- Bit 6 is stored but unused.
- In other palettes both bits are stored and ignored.

### 9th blue bit
- Any 8-bit write path ($41, ULA+ port $FF3B) sets `B0 = B2|B1`, where B2:B1 are the two blue bits of RRRGGGBB.
- Only $44 sets B0 explicitly.

### Reset contents
- The FPGA does **not** initialise palette RAM. The BRAM is zero after configuration, and soft reset does not touch it.
- The firmware (tbblue.fw / NextZXOS) loads the palettes. The values below are what emulators use (ZEsarUX `tbblue_reset_palettes`). **[UNCONFIRMED vs firmware]**
- **L2, Sprites, Tilemap (both palettes):** `colour9[i] = i<<1 | B0`. This is identity RRRGGGBB. ZEsarUX sets B0 from `i&2`; the hardware 8-bit rule would give `(i&2)|(i&1)`.
- **ULA (both palettes):** a 16-entry table repeated 16 times, so `entry[i] = T[i & 15]`:

| i | colour | 9-bit | ≈8-bit |
|---|---|---|---|
| 0 | black | 0x000 | 00 |
| 1 | blue | 0x005 | 02 |
| 2 | red | 0x140 | A0 |
| 3 | magenta | 0x145 | A2 |
| 4 | green | 0x028 | 14 |
| 5 | cyan | 0x02D | 16 |
| 6 | yellow | 0x168 | B4 |
| 7 | white | 0x16D | B6 |
| 8 | bright black | 0x000 | 00 |
| 9 | bright blue | 0x007 | 03 |
| 10 | bright red | 0x1C0 | E0 |
| 11 | bright magenta | **0x1CF** | E7 |
| 12 | bright green | 0x038 | 1C |
| 13 | bright cyan | 0x03F | 1F |
| 14 | bright yellow | 0x1F8 | FC |
| 15 | bright white | 0x1FF | FF |

- Bright magenta is stored as 0x1CF (E7), not 0x1C7 (E3), so that it does not match the default global transparent colour $E3.
- Standard-mode indexes: ink 0-7, bright ink 8-15, paper 16-23, bright paper 24-31 (see §4). With the 16-entry repeat, paper 16-23 = T[0-7].

### ULANext (NR $43 bit 0 = 1) (ula:492-529)
`attr` = the attribute byte (or the border pseudo-attribute `00bbbbbb`).

| pixel | palette index |
|---|---|
| ink | `attr AND mask` (mask = NR $42), for any mask value |
| paper, mask ∈ {01,03,07,0F,1F,3F,7F} | `128 + (attr >> popcount(mask))` |
| paper, any other mask (incl. FF) | the "background" flag is set: colour = NR $4A fallback |
| border, mask ≠ FF | `128 + border` (border 0-7, from `attr` bits 5:3) |
| border, mask = FF | fallback NR $4A |

- In ULANext there is no FLASH and no BRIGHT.
- nextreg.txt says the border also uses the fallback colour for invalid masks. The VHDL only does that for `$FF`. Follow the VHDL.
- Fallback-as-ULA colour: `nr4a<<1 | (b1|b0)` (zxnext:6987-6990). It still goes through the NR $14 transparency test. At reset NR $4A = NR $14 = $E3, so full-ink paper is **transparent** by default.

### ULA+ (ula:531-541; ports $BF3B/$FF3B, zxnext:4520-4580)
- Enable: port $FF3B bit 0 (when the $BF3B group is 01), or NR $68 bit 3.
- Index: `192 + attr[7:6]*16 + P*8 + c`.
  - `P` = 1 for paper (or always 1 in Timex hi-res).
  - `c` = attr bits 2:0 for ink, bits 5:3 for paper.
- No flash.
- Border = `attr 00bbbbbb`, so group 0 paper: `192 + 8 + border`.
- `$BF3B` write: bits 7:6 = group. Group 00: bits 5:0 = index 0-63.
- `$FF3B` data is **GGGRRRBB**. On write it is converted to RRRGGGBB plus the OR'd B0 (zxnext:4743). It is written to ULA palette `NR43[6]`, entry `192+index`. A read converts back.
- ULANext has priority over ULA+ when both are enabled.

---

## 3. Transparency

| Layer | Test | Where |
|---|---|---|
| ULA (incl. border, LoRes, ULANext fallback) | `rgb9[8:1] == NR14` after palette lookup, **or** clipped, or ULA disabled | zxnext:7100-7104 |
| Layer 2 | `rgb9[8:1] == NR14` after lookup, or outside clip/area, or disabled | zxnext:7121 |
| Tilemap, normal | 4-bit pixel **index** (before the palette offset) `== NR4C[3:0]` | tm:427 |
| Tilemap, text mode | `rgb9[8:1] == NR14` (NR4C ignored) | zxnext:7109 |
| Sprite 8-bit | raw pattern byte (before the palette offset) `== NR4B` | spr:971 |
| Sprite 4-bit | raw nibble `== NR4B[3:0]` | spr:971 |

- NR $14 global transparent colour: reset $E3. It is compared with the top 8 bits of the 9-bit colour, so blue LSB is ignored. A colour test, not an index test.
- NR $4A fallback: reset $E3. It is the output colour when no layer is opaque (`nr4a<<1 | (b1|b0)`, zxnext:7214). It is also the ULANext background (§2).
- NR $4B sprite transparent index: reset $E3.
- NR $4C tilemap transparent index: bits 3:0, reset $F. Read: `0000 & idx`.

---

## 4. ULA on the Next

### Standard pixel index (ula:545-553)
```
ink   (pixel=1): idx = 0  + BRIGHT*8 + attr[2:0]
paper (pixel=0): idx = 16 + BRIGHT*8 + attr[5:3]
pixel = bit XOR (attr.7 AND flash_cnt.4)      ; flash toggles every 16 frames (ula:470-480)
```

### Border
- Pseudo-attribute `00 bbb bbb` from port $FE bits 2:0, so it renders as paper `16+b` (non-bright) (ula:418, 428).
- In Timex hi-res the whole screen *including the border* uses `01 ~c c` (c = port $FF bits 5:3).
  - Ink = `8+c`. Paper/border = `24+(7-c)` (ula:419, 426).
- The border is an ordinary ULA colour. It is transparent only if its RGB equals NR14 or the ULA is disabled. It is never clipped (ula:562).
- Border colour change granularity: the attribute register is loaded every 8 pixels (`hc` = 4 and C). On Pentagon timing it reloads every 14 MHz tick in the border (ula:443-449).

### NR $68 ULA control (zxnext:5444-5450, read 6093)
| bit | meaning |
|---|---|
| 7 | 1 = disable ULA output (ULA and LoRes become transparent) |
| 6:5 | blend source for SLU 110/111: 00 ULA, 10 ULA+TM mix result, 11 TM, 01 no blend (§8) |
| 4 | cancel extended keys in the 8x5 matrix (not video) |
| 3 | ULA+ enable (the same flip-flop as port $FF3B bit 0) |
| 2 | ULA half-pixel X scroll: shifts left by one extra 14 MHz pixel |
| 1 | reserved (reads 0) |
| 0 | stencil mode (§6) |

- Reset value: 0.

### NR $1A ULA/LoRes clip (x1,x2,y1,y2), inclusive
- Coordinates are paper coordinates: x = `phc` 0-255, y = `vc` 0-191.
- If y2 ≥ 192 (bits 7:6 = 11), y2 is treated as 191 (zxnext:6779).
- Reset 0,255,0,191.
- Applies only to paper; the border is never clipped. A clipped ULA pixel is transparent (ula:562).

### Clip index registers (all four windows)
- Each write to $18/$19/$1A/$1B stores X1→X2→Y1→Y2 and increments a 2-bit index that wraps.
- Reads return the value at the current index and do not advance it.
- NR $1C write: bit 0 resets the L2 index, bit 1 the sprite index, bit 2 the ULA index, bit 3 the TM index.
- NR $1C read: `TM[7:6] ULA[5:4] SPR[3:2] L2[1:0]`.

### NR $26 / $27 ULA scroll (ula:192-216, 389-401)
```
fetch_x = (x + NR26) mod 256         ; fine bits shift the 16-bit hires shift register
                                     ; NR68.2 adds half a pixel
fetch_y = (y + NR27) mod 192         ; exact for any NR27 0-255 (ula:201-207)
```
- The attribute follows the same scrolled position. The scroll affects paper only.

### Port $FF Timex (ula:191, 223-252, 389-393) — §10.

---

## 5. Layer 2

### Port $123B (zxnext:3901-3934)
Write with bit 4 = 0:
| bit | meaning |
|---|---|
| 7:6 | segment: 00/01/10 = map 16K bank `B+seg+off` at $0000-$3FFF. 11 = map `B+off+0..2` at $0000-$BFFF (A15:14 selects) |
| 5 | reserved |
| 3 | 0 = map NR $12 (`B`), 1 = map NR $13 shadow (mapping only; the display always uses NR $12) |
| 2 | enable mapping for **reads** |
| 1 | enable Layer 2 **display** (alias NR $69 bit 7) |
| 0 | enable mapping for **writes** |

Write with bit 4 = 1:
- Bits 2:0 = `off`, a 16K bank offset added to the *mapping* only. It does not change the other bits.

Read:
- `seg[7:6] 0 0 shadow rd en wr`. The offset is not readable.

Mapping (zxnext:2966-2970, 3065, 3077):
```
page8k = 2*(B + off + (seg==3 ? A15:14 : seg)) + A13
```
- The mapping overrides the MMU only for the enabled access type.
- It has priority below DivMMC ROM/RAM and above alt-ROM/ROMCS.
- Reset value: 0.

### NR $12 / $13
- Bits 6:0 = 16K bank (reset 8 / 11). Bit 7 reads 0.

### NR $69 Display control 1 (zxnext:3617, 3658, 3924, 6096)
- Write: bit 7 → L2 enable (port $123B bit 1), bit 6 → port $7FFD bit 3 (ULA shadow screen, bank 7), bits 5:0 → port $FF bits 5:0.
- Read: the same layout from the live registers.

### NR $70
- Bits 5:4 = resolution: 00 256x192x8, 01 320x256x8, 1x 640x256x4.
- Bits 3:0 = palette offset. Reset 0.

### NR $16 / $71 / $17
- X scroll = `NR71.0 : NR16` (9 bits). Y scroll = NR17 (8 bits).

### Pixel pipeline (l2:126-210)
```
if res==00:                      ; 256x192, uses phc / vc (paper coordinates)
   valid = x<256 && y<192
   X = (x + scrollX) & 0xFF                          ; NR71 bit ignored
   Ys = y + scrollY                                  ; 9-bit
   Y = (Ys>=192) ? (Ys+64)&0xFF : Ys                 ; = mod 192 if scrollY<=191 (l2:157)
   addr = Y*256 + X                                  ; row-major, 48K = 3 banks
else:                            ; 320x256 or 640x256, uses whc / wvc
   valid = x<320 && y<256
   Xs = x + scrollX                                  ; up to 830
   X = (Xs<320) ? Xs : (Xs+192)&0x1FF                ; = Xs-320; scrollX 0-319 meaningful (l2:153)
   Y = (y + scrollY) & 0xFF
   addr = X*256 + Y                                  ; column-major, 80K = 5 banks (l2:160)
byte = RAM[(NR12 + addr>>14)*16K + (addr & 0x3FFF)]
if bank+addr>>14 >= 112 -> transparent (SRAM range check, l2:172-175)
pix8 = res!=1x ? byte : (left half ? byte>>4 : byte&15)   ; 640: HIGH nibble = left pixel
index = (((pix8>>4) + NR70[3:0]) & 15)<<4 | (pix8 & 15)    ; palette offset (l2:203)
```
- In 640 mode, `index = offset<<4 | nibble`.

### Clip NR $18 (l2:128-145)
- res 00: x1..x2 against x 0-255, y1..y2 against y 0-191.
- res 01/1x: x from `x1*2` to `x2*2+1` in 320 coordinates (so 4 hi-res pixels per unit in 640 mode); y1..y2 against 0-255.
- The clip is in screen space, not scrolled. Inclusive.
- Reset 0,255,0,191. 320/640 code must set y2=255 and x2=159.

### Position
- 256x192 covers the paper (whc 32-287, wvc 32-223).
- 320x256 and 640x256 cover the whole surface (whc 0-319, wvc 0-255).

---

## 6. Tilemap (tm:*, zxnext:4378-4410)

### NR $6B (reset 0) (tm:189-195)
| bit | meaning |
|---|---|
| 7 | enable |
| 6 | 0 = 40x32 (8-pixel tiles at 320 res), 1 = 80x32 (8 hi-res pixels per tile at 640 res) |
| 5 | no attribute bytes: map is 1 byte/entry, attribute = NR $6C |
| 4 | tilemap palette select (0 first, 1 second) |
| 3 | text mode |
| 2 | reserved |
| 1 | 512-tile mode |
| 0 | tilemap always over ULA (forces "below" = 0) |

### NR $6C
- Default attribute, used when bit 5 is set. Same layout as the attribute byte. Reset 0.

### NR $6E map base / NR $6F tile base
- Bit 7: 1 = bank 7, 0 = bank 5. Bit 6 reserved. Bits 5:0 = offset in 256-byte units.
- Offsets: bank 5 at $4000 + n*256; bank 7 at $C000 + n*256 of bank 7.
- Reset: $6E = $2C ($6C00), $6F = $0C ($4C00). Read: `b7 0 b5..0`.
- The address adds `(addr[13:8] + base[5:0]) & 63` and wraps at 16K. Bank 7 has only 8K of BRAM, so it wraps at 8K (tm:403; nextreg.txt).

### Scroll
- NR $2F bits 1:0 + NR $30 = 10-bit X. NR $31 = Y.
```
X = (x + scrollX) mod 320   (40-col; x in 0-319)      ; tm:309-318
X = (x + scrollX) mod 640   (80-col; x in 0-639 hi-res)
Y = (y + scrollY) & 0xFF
```

### Clip NR $1B (tm:412-424)
- X from `x1*2` to `x2*2+1` in **320** coordinates in both modes. Y from y1 to y2 (0-255).
- Reset 0,159,0,255.

### Map entry address (tm:395-398)
```
col = X>>3 ; row = Y>>3 ; w = 40 or 80
entry = row*w + col
attrs:    tile = mem[map + entry*2], attr = mem[map + entry*2 + 1]
no attrs: tile = mem[map + entry],   attr = NR6C
```

### Attribute byte
| bit | normal | text mode |
|---|---|---|
| 7:4 | palette offset (high nibble) | 7:1 = 7-bit palette "offset" |
| 3 | X mirror | (part of offset) |
| 2 | Y mirror | (part of offset) |
| 1 | rotate | (part of offset) |
| 0 | ULA over tilemap ("below"); in 512 mode: tile bit 8 | same |

### Tile pixel, 4bpp, 32 bytes/tile (tm:320-324, 382-394)
```
tile9 = (mode512 ? attr.0 : 0)<<8 | tile
xm  = attr.3 XOR attr.1          ; rotate inverts X mirror
ex  = xm     ? 7-px : px
ey  = attr.2 ? 7-py : py
(tx,ty) = attr.1 ? (ey,ex) : (ex,ey)     ; rotate swaps
byte = mem[tiles + tile9*32 + ty*4 + (tx>>1)]
nib  = tx even ? byte>>4 : byte&15       ; HIGH nibble = left (even) pixel
index = attr[7:4]<<4 | nib               ; offset replaces the high nibble, no add
transparent if nib == NR4C
```
- Result of mirror then rotate: rotate alone = 90° clockwise.

### Text mode (tm:385-386, 394)
```
byte = mem[tiles + tile9*8 + py]           ; 1bpp, 8 bytes/tile, bit7 = leftmost
bit  = (byte << px).7
index = attr[7:1]<<1 | bit
```
- No mirror/rotate.
- Transparency: the RGB is compared with NR $14, not with NR $4C.
- Attribute bit 0 still means "below" (or tile bit 8 in 512 mode).

### 512-tile mode
- `attr.0` becomes tile bit 8.
- The "below" flag is forced to 1, so the tilemap is under the ULA unless NR6B.0 = 1 (tm:388).
- The 512 tiles need 16K of tile data (`tile9*32`), which wraps within the bank.

### Below flag
- `below = (attr.0 OR mode512) AND NOT NR6B.0`.
- Also forced: when the tilemap is disabled, `below = NOT NR6B.0` (zxnext:6863). This only matters for blend mode routing.

### ULA + tilemap → one "U" layer (zxnext:7100-7137)
```
ulaT = ula_rgb[8:1]==NR14 || ula_clipped || !ula_en(NR68.7=0)
tmT  = !tm_pixel_en(clip / index==NR4C) || (textmode && tm_rgb[8:1]==NR14) || !NR6B.7
if NR68.0 && ula_en && tm_en:                     ; stencil
    U = (ulaT||tmT) ? transparent : (ula_rgb AND tm_rgb)   ; bitwise on 9 bits
else:
    U = (!tmT && (!below || ulaT)) ? tm_rgb : ula_rgb ; U_T = ulaT && tmT
```
- Both layers cover the whole 320x256: the ULA includes its border, and the tilemap is over or under it.
- Palette: the tilemap reads the ULA/TM RAM at `1 : NR6B.4 : index`.

### Memory timing
- Fetches happen one tile ahead. The parameters below are latched per tile fetch (tm:345-354). See §11.

---

## 7. Sprites (sprites.vhd)

128 sprites, 16K pattern RAM (64 x 256-byte 8-bit patterns or 128 x 128-byte 4-bit patterns).

### Ports
- **$303B write:**
  - Sprite number = `d[6:0]`, so the attribute index = `d[6:0]*8`, sub-index 0 (spr:655-657).
  - Pattern address = `d[5:0]*256 + d.7*128` (spr:735-736).
  - The sprite number and pattern address are separate counters.
- **$303B read:** `000000 overflow collision`. Reading clears both flags (spr:979-995).
  - Bit 1 = rendering for some line was not finished when the next line began (§7 limit).
  - Bit 0 = a non-transparent sprite pixel was written onto a line-buffer pixel already set by another sprite on the same line.
  - Collision is recorded before the priority gate, on any rendered line including offscreen/clipped areas within x<320, and even when NR15.0 = 0.
- **$57 write:** writes attribute `sub` of the current sprite, then `sub++` (spr:639-664).
  - After writing attr 3 with bit 6 = 0, or after writing attr 4, it moves to the next sprite with sub = 0.
  - The sprite number wraps 127→0.
  - When attr 4 is skipped, its old value stays but is ignored, because E=0 masks every attr-4 use.
- **$5B write:** writes a byte at the pattern address, then increments it (14 bits, wraps at 16K).

### NextRegs
- **$34:** sprite number (bits 6:0). Read returns `0 & num`.
  - If NR $09 bit 4 ("tie") is set, a write also acts as `OUT $303B`, including the pattern address with bit 7 as the +128 (spr:600-614, 733-734).
  - With tie, port $303B and $57 auto-advance also update NR $34.
- **$35-$39:** write attr 0-4 of the NR $34 sprite directly. No skip logic.
- **$75-$79:** the same, then NR $34 sprite++ (`nr_wr_reg(6)`, zxnext:4916). With tie, the pattern bit 7 is carried.

### Attributes, anchor / normal sprite
| byte | bits |
|---|---|
| 0 | X[7:0] |
| 1 | Y[7:0] |
| 2 | 7:4 palette offset, 3 X mirror, 2 Y mirror, 1 rotate, 0 X8 |
| 3 | 7 visible, 6 E (attribute 4 present), 5:0 pattern N5:N0 |
| 4 (if E) | 7 H (4-bit), 6 N6 (with H: 4-bit half-pattern select), 5 T (relatives: 0 composite, 1 unified), 4:3 XX scale, 2:1 YY scale, 0 Y8 |

- Byte 4 with bits 7:6 = `01` marks a *relative* sprite, so an anchor never has H=0/N6=1.
- If E=0: Y8 = 0, 8-bit, no scaling, and the sprite is a composite anchor.
- Scale: 00 x1, 01 x2, 10 x4, 11 x8.

### Attributes, relative sprite (E=1 and attr4[7:6]=01) (spr:756-804)
| byte | bits |
|---|---|
| 0 | X offset, signed 8-bit |
| 1 | Y offset, signed 8-bit |
| 2 | 7:4 palette offset, 3 XM, 2 YM, 1 rot, 0 PR (palette offset relative to anchor) |
| 3 | 7 visible, 6 =1, 5:0 N5:N0 |
| 4 | 7:6 =01, 5 N6, 4:3 XX, 2:1 YY (composite only), 0 PRel (pattern relative to anchor) |

### Anchor state
- Latched for every non-relative sprite in index order (spr:929-949).
- `anchor_vis` is reset to 0 at the start of each line, so relatives before any anchor are invisible.
```
A.x,A.y (9-bit), A.vis=attr3.7, A.pat = N5:0<<1|N6 (N6=attr4.6 & H), A.pal = attr2[7:4]
A.H = E & attr4.7 ; A.T = E & attr4.5
if E && T: A.rot,A.xm,A.ym = attr2.1,.3,.2 ; A.xs,A.ys = attr4[4:3],[2:1]  else all 0
```

### Relative sprite resolution
```
ox,oy = attr0,attr1
if A.rot: swap(ox,oy)
if A.rot XOR A.xm: ox = -ox          ; 8-bit two's complement
if A.ym:           oy = -oy
ox = sext9(ox) << A.xs ; oy = sext9(oy) << A.ys   ; 9-bit result, wraps mod 512
x = (A.x + ox) & 511 ; y = (A.y + oy) & 511
pal  = attr2.0 ? (A.pal + attr2[7:4]) & 15 : attr2[7:4]
pat7 = (N5:0<<1 | N6rel) ; if attr4.0: pat7 = (pat7 + A.pat) & 127   ; N6rel = attr4.5 & A.H
H = A.H   (4-bit-ness always from the anchor)
vis = A.vis AND attr3.7
composite (A.T=0): xm,ym,rot = own attr2 bits ; scale = own attr4[4:1]
unified   (A.T=1):
   own_xm' = A.rot ? (ym XOR rot) : xm
   own_ym' = A.rot ? (xm XOR rot) : ym
   xm = A.xm XOR own_xm' ; ym = A.ym XOR own_ym' ; rot = A.rot XOR rot
   scale = anchor's
```
- In the composite case, the anchor's mirror/rotate/scale do not affect offsets: the `A.*` transform registers are 0.

### Pattern addressing (spr:816, 962-963)
- 8-bit: `addr = N5:0*256 + row*16 + col`.
- 4-bit: `addr = N5:0*256 + N6*128 + (row*16+col)>>1`. The high nibble is the even (left) pixel.
- 4-bit pattern N = `N5:0<<1|N6` covers 0-127.

### Mirror / rotate, per screen pixel (sx,sy) of the 16x16 (unscaled) cell
```
ey = YM ? 15-sy : sy
ex = (XM XOR ROT) ? 15-sx : sx
(row,col) = ROT ? (ex, ey) : (ey, ex)      ; ROT alone = 90° clockwise
```
- Scaling: `sy = ((line - y) mod 512) >> yscale`. Each pattern pixel is repeated `2^xscale` times horizontally.

### Pixel value
- 8-bit: `idx = ((b>>4)+pal)&15)<<4 | b&15`. Transparent if `b == NR4B`.
- 4-bit: `idx = pal<<4 | nib`. Transparent if `nib == NR4B[3:0]`.
- Looked up in the sprite palette `NR43.3`.

### Coordinates
- X and Y are 9-bit, in 320x256 surface space. (32,32) is the top-left of the paper.
- Y without E is 0-255.
- Both axes **wrap mod 512**:
  - A sprite with y=500 shows rows 12-15 at lines 0-3, because `(line - y) mod 512 < 16<<ys` (spr:806-811).
  - X: drawing continues through 320-511 and wraps to 0 (spr:855).
- Only x<320 is written. Off-screen lines are rendered but not shown.

### Priority
- Rendering goes from sprite 0 to 127 into a line buffer.
- NR15.6 = 0: later sprites overwrite, so **127 is on top**.
- NR15.6 = 1: a pixel is written only if it is empty, so **0 is on top** (spr:972).

### Clip NR $19 (spr:1043-1067)
| NR15.1 over-border | NR15.5 | window (surface coordinates, inclusive) |
|---|---|---|
| 0 | x | x `x1+32 .. x2+32`, y `y1+32 .. y2+32`, and y < 224 (paper only, 256x192 coordinates) |
| 1 | 0 | whole 320x256 (NR $19 ignored) |
| 1 | 1 | x `x1*2 .. x2*2+1`, y `y1 .. y2` |

- Reset 0,255,0,191.
- NR15.0 = sprite output enable. Gating is at the mixer only; the engine and the collision logic keep running (zxnext:6934).

### Per-line limit
- The limit is time-based, not a count. Line *n+1* is rendered during line *n* into a double buffer. It starts at `whc = 511`, just before `whc = 0` (spr:516-540).
- Clock: 28 MHz, about 1792 cycles per 448-pixel line (1824 for 456).
- Cost **[derived from the state machine, UNCONFIRMED by test]**:
  - 1 cycle per sprite slot examined (all 128).
  - Plus `16 << xscale` cycles per visible sprite on the line.
  - A sprite is cut short when it passes x≥320 outside the wrap region.
  - That gives about 100 1x sprites per line.
- If rendering has not reached the end at the next line start, the overflow flag is set and the remaining sprites are not drawn on that line.

---

## 8. Layer priority and mixing (zxnext:7097-7356)

Inputs:
- `L` = Layer 2 rgb9 / transparency, plus priority `P = paletteL2[idx].bit15 AND L opaque`.
- `S` = sprite.
- `U` = the ULA/TM result from §6.
- `B` = the ULA border flag (paper/border, from `phc` ≥256 or `vc` ≥192).

### NR $15 (reset 0)
| bit | meaning |
|---|---|
| 7 | LoRes enable |
| 6 | sprite 0 on top |
| 5 | sprite clip in over-border mode |
| 4:2 | layer order |
| 1 | sprites over border |
| 0 | sprites visible |

### Order list
The first opaque layer wins. Otherwise the fallback NR $4A is shown.

| 4:2 | order | exact rule |
|---|---|---|
| 000 | S L U | P→L; S; L; U |
| 001 | L S U | L; S; U (P irrelevant) |
| 010 | S U L | P→L; S; U; L |
| 011 | L U S | L; U*; S |
| 100 | U S L | P→L; U*; S; L |
| 101 | U L S | P→L; U*; L; S |
| 110 | blend add | see below |
| 111 | blend add−5 | see below |

`U*` = U is skipped when `B && tmT && S opaque`. Sprites always show over the **border** when the tilemap is transparent there, even in U-above-S orders (zxnext:7256, 7266, 7278).

### Blend modes
Per channel, on 3-bit components (R=8:6, G=5:3, B=2:0 including B0):
- `M` = blend colour.
- `Ltop`/`Lbot` = U parts placed above or below the sprites.
- Transparent inputs count as 0.

NR68[6:5] chooses M, top and bottom:
| NR68[6:5] | M | top (above S) | bottom (below S) |
|---|---|---|---|
| 00 | ULA alone (`ula_rgb`; transparent if NR14 match or clipped. **Not** gated by NR68.7) | TM if opaque and not below | TM if opaque and below |
| 10 | U (the ULA/TM result incl. stencil) | — | — |
| 11 | TM | ULA if opaque and TM below | ULA if opaque and TM above |
| 01 | none (M transparent) | below ? ULA : TM | below ? TM : ULA |

```
s = L + M                         ; per channel 0..14
mode 110: c = min(s, 7)
mode 111: if M transparent: c = L                 ; no -5 (zxnext:7314)
          else c = s<=4 ? 0 : s>=12 ? 7 : s-5
out = P ? c : top ? top : S ? S : bottom ? bottom : L opaque ? c : fallback
```
- M on its own is **never** shown. Where L is transparent, the blend colour does not appear. Only top/bottom and S can show there.

### When everything is transparent
- Output = `NR4A<<1 | (b1|b0)`.

### Layer 2 priority bit
- Only bit 7 of the 2nd NR $44 write into an L2 palette entry sets it.
- It applies in every order (000, 010, 100, 101, 110, 111). In 001/011 L is already on top.

---

## 9. LoRes (lores.vhd; NR $15.7, $32, $33, $6A)

- 128x96, each pixel 2x2, in the paper area. It replaces the ULA *paper* pixel. The border stays the ULA border.
- It uses the ULA palette (NR43.1), the ULA clip NR $1A, NR14 transparency and NR68.7 disable.

```
x = (phc + NR32) & 255 ; Ys = vc + NR33 ; y = Ys>=192 ? (Ys+64)&255 : Ys   ; units = half LoRes pixel
standard (NR6A.5=0): a = (y>>1)*128 + (x>>1) ; if y>=96: a += 0x800 → bank5 $4000-$57FF rows 0-47,
                     $6000-$77FF rows 48-95 ; idx = ((b>>4)+NR6A[3:0])&15)<<4 | b&15
radastan (NR6A.5=1): 4bpp, a = dfile*$2000 + (y>>1)*64 + (x>>2), dfile = portFF.0 XOR NR6A.4
                     nib = x.1 ? b&15 : b>>4 ; idx = NR6A[3:0]<<4 | nib
                     (ULA+ on: idx = 0b11<<6 | NR6A[1:0]<<4 | nib)
```
- NR $6A: bit 5 radastan, bit 4 dfile XOR, bits 3:0 palette offset.

---

## 10. Timex port $FF (ula:191-252, 389-393, 418-427)

- Bits 2:0 = mode. Bits 5:3 = hi-res colour. Bit 6 = disable the ULA frame interrupt.
- Ignored (standard screen) while the ULA shadow screen is on (bank 7, port $7FFD.3).

| mode | display |
|---|---|
| 000 | screen 0 at $4000 |
| 001 | screen 1 at $6000 |
| 010 | hi-colour: pixels at $4000, attribute per pixel byte at $6000 + the same offset (8x1 attribute) |
| 110 | hi-res 512x192: each cell = byte at $4000 (left 8) then byte at $6000 (right 8). Ink `8+c`, paper and border `24+(7-c)`. No FLASH |

- Other values decode bit by bit: bit 0 = pixel dfile, bit 1 = attribute from $6000 pixel layout, bit 2 = hi-res.
- Hi-res attribute for palette/ULANext/ULA+ = `01 ~c c`.

---

## 11. When changes take effect

| What | Granularity | Ref |
|---|---|---|
| Palette RAM writes | immediate (next lookup) | zxnext:6960 |
| NR14, 4A, 42, 43 (active palettes, ULANext), 68 (enable, stencil, blend), 6B.7 tm enable, 6B.4 tm palette, 15.0 sprite enable, $FF3B ULA+ enable | per pixel (sampled each 7 MHz pixel) | zxnext:6804-6831 |
| NR15[4:2] order, NR32/33, NR6A | per pixel | zxnext:6768-6799 |
| Layer 2: enable, NR70, NR12, scroll, clip | per pixel | l2:105-140 |
| ULA clip NR1A | per pixel | zxnext:6775 |
| ULA scroll NR26/27, port $FF mode, shadow screen | per 8-pixel character fetch | ula:194-214 |
| Border colour ($FE) | per 8 pixels (Pentagon: per half pixel) | ula:421-453 |
| Attributes/pixels in VRAM | read at fetch time, about one character ahead | ula:226-306 |
| Tilemap NR6B[6:0] (40/80, attr, text, 512, on-top), NR6C, NR6E/6F, scroll X | per tile (8 pixels), latched at each tile fetch one tile ahead | tm:217-226, 345-354 |
| Tilemap scroll Y, transparent index NR4C, clip | per pixel / per fetch | tm:326, 412-427 |
| Sprite attributes and patterns | used when line *n+1* is rendered during line *n*. A mid-line change affects the next line depending on how far rendering has got | spr:516-540 |
| Sprite clip, NR15.1/.5 | per pixel | spr:1037-1067 |
| NR15.6 sprite 0 on top | while rendering (live) | spr:972 |
| Flash phase | toggles every 16 frames at hc=vc=0 | ula:474-480 |

Nothing is latched once per frame. Raster effects (copper or CPU) work at the granularity above.

---

## Not settled / caveats
- **Palette reset contents:** set by firmware, not the FPGA. The values in §2 come from the ZEsarUX emulator, not from firmware source.
- **ULANext border with a non-standard mask:** the VHDL uses `128+border`; nextreg.txt says fallback. The VHDL is followed here.
- **Sprites per line:** the ~100 figure is derived from the state machine cycle count, not measured.
- **L2 256x192 with scrollY 192-255, and LoRes with scrollY > 191:** the VHDL gives `(Ys+64)&255`, which can address rows 192-255 (garbage rows). Documented as "limit 0-191".
- **Blend mode 00:** ULA as blend colour ignores the NR68.7 ULA-disable bit (zxnext:7100-7101, 7143). This is literal VHDL behaviour.
- **Pixel pipeline delays:** each module is one pixel ahead (`hc+1`) to compensate for its pipeline. An emulator can treat all layers as aligned to whc/wvc.

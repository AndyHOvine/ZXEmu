# ZX Spectrum Next: system hardware reference (copper, interrupts, CTC, DMA, sound, input)

Source: the official FPGA core, `cores/zxnext/src`. Paths below are relative to that folder. `zxnext.vhd:N` means line N.
**[VHDL]** means read from the code. **[doc]** means from nextreg.txt or ports.txt only. **[?]** means not confirmed, or inferred.
Where the docs and the VHDL disagree, the VHDL wins and the clash is noted.

Clocks used below:
- `CLK28`: the system clock. Nominally 28 MHz. It really depends on NR $11: VGA0 = 28.000, VGA1 = 28.571, ... VGA6 = 33.0 MHz. HDMI is about 27 MHz (ports.txt UART note).
- `CLK7` = CLK28/4: the pixel clock.
- `CLK_CPU`: 3.5/7/14/28 MHz (NR $07), stretched by contention.

---

## 0. Raster counters (shared by the copper, the line interrupt and NR $1E/$1F)

`video/zxula_timing.vhd`:

| Counter | Meaning |
|---|---|
| `hc` | Raw horizontal count in CLK7 pixels: 0..447 (48K, Pentagon) or 0..455 (128K/+3). |
| `vc` | Raw line count. 0 = start of vblank. Max 311 (48K 50 Hz), 310 (128K 50 Hz), 319 (Pentagon), 263 (60 Hz). |
| `hc_ula` (exported as `hc`) | Resets to 0 when `hc = c_min_hactive - 12`, then counts up in CLK7 pixels (lines 423-438). Paper x = 0 is at `hc_ula = 12`. `c_min_hactive` is 128 (48K/Pentagon) or 136 (128K). |
| `cvc` (the "copper vc") | Steps when `hc_ula` wraps to 0. On the paper-top line (`vc = c_min_vactive`) it loads **NR $64**, otherwise it counts +1 and wraps at `c_max_vc` (lines 456-472). |

So with NR $64 = 0, **cvc 0 = the first paper row (ULA pixel row 0)**. cvc 0..191 are the paper rows, 192+ is the bottom border, then vblank and the top border, up to `c_max_vc`, then 0 again. Each cvc line starts 12 pixels before the left paper edge.

NR $1E/$1F read `cvc` (bit 8 in $1E bit 0) (`zxnext.vhd:5983-5986`).

The ULA frame interrupt, in cvc terms when NR $64 = 0 [VHDL, derived from lines 155-293]:

| Timing | vc | hc (raw) | hc_ula | cvc |
|---|---|---|---|---|
| 48K 50 Hz | 0 | 116 | 0 | 248 |
| 48K 60 Hz | 0 | 116 | 0 | 224 |
| 128K 50 Hz | 1 | 128 | 4 | 248 |
| +3 50 Hz | 1 | 126 | 2 | 248 |
| Pentagon | 319 | 439 | 323 | 239 |

---

## 1. Copper

Files: `device/copper.vhd` (whole module) and `zxnext.vhd:3942-3999, 4709-4777, 5419-5442`.

### 1.1 Memory and the CPU-side registers

- The list holds 1024 instructions of 16 bits (2 KB). The CPU-side **write address** `nr_copper_addr` is 11 bits and counts **bytes**.
- The copper's own **PC** (`copper_list_addr_s`) is separate. It is 10 bits and counts **instructions**. NR $61/$62 set only the write address. They never move the PC.

| NR | R/W | Bits |
|---|---|---|
| $60 | W | Write one byte at the write address, then address+1. An even address is the MSB (written at once). An odd address is the LSB (written at once) (`zxnext.vhd:3977-3999`). |
| $61 | R/W | Write address bits 7:0. Reading gives them back. |
| $62 | R/W | Bits 7:6 = mode. Bits 2:0 = write address bits 10:8. Reading returns `mode & "000" & addr[10:8]` (`zxnext.vhd:6087`). |
| $63 | W | 16-bit write. At an even address the byte is latched only. At an odd address, the latched MSB and this LSB are written together. The address goes +1 after each byte. Use it to change a running list without tearing. |
| $64 | R/W | Line offset. See §0 and §1.5. |

The write address wraps from $7FF to 0.

### 1.2 Modes (NR $62 bits 7:6)

The copper compares `mode` with the previous mode on every CLK28 cycle (`copper.vhd:70-83`):

```
on CLK28:
  if mode != last_mode:                      // only on a change; rewriting the same value does nothing
      last_mode = mode
      if mode == 01 or mode == 11: PC = 0    // 10 keeps the PC (resume)
      dout = 0                               // that cycle runs no instruction
  elif mode == 11 and cvc == 0 and hc_ula == 0:
      PC = 0                                 // frame restart (true for 4 CLK28 cycles; PC stays 0)
  elif mode != 00:
      execute(list[PC])
```

| Mode | Effect |
|---|---|
| 00 | Stopped. The PC is kept. |
| 01 | Start from PC = 0. Never restarts on its own. |
| 10 | Resume from the current PC. |
| 11 | Start from 0, and reset to 0 at **cvc = 0, hc_ula = 0**. That is 12 pixels before the paper top-left corner, and it moves with NR $64. It is not raster position (0,0) of the whole frame. |

"Loop to the start" in nextreg.txt only means that the 10-bit PC wraps from 1023 to 0.

### 1.3 Instruction encoding

```
WAIT : 1 hhhhhh vvvvvvvvv     h = bits 14:9 (6 bits), v = bits 8:0 (9 bits)
MOVE : 0 rrrrrrr dddddddd     r = NextReg $00-$7F, d = value
```

- **The MOVE register field is 7 bits.** The register written is `'0' & r` (`zxnext.vhd:4731`). **So the copper can only write NR $00-$7F.**
- **NOP:** a MOVE whose register is 0 makes no write pulse, **whatever its value** (`copper.vhd:104`). The doc says "MOVE 0,0", but the code tests only r = 0. So the copper can never write NR $00.
- **HALT = $FFFF** = WAIT v=511, h=63. cvc never goes above 319, so it never matches. The copper sits there until the mode-11 frame restart or a mode change.

### 1.4 Timing

- The list RAM is read on the falling edge of CLK28 (`ram/dpram2.vhd`, `clk_b_i => i_CLK_28_n`). So an instruction is fetched and executed in **one CLK28 cycle**.
- **MOVE takes 2 cycles.** The first cycle executes and sets `dout`. The second cycle only clears `dout` (`copper.vhd:87-89`). **NOP takes 1 cycle. A WAIT is tested on every cycle.**
- The register write: the rising edge of `dout` makes `copper_req` for one CLK28 cycle. The copper has priority over CPU NextReg writes, and a CPU write waits (`zxnext.vhd:4723-4777`). It is the same write path as a CPU write, so the effects are identical.
- At most **14 M MOVEs per second**: 896 per line (48K, 448 px × 4 / 2) or 912 per line (128K). That is 2 MOVEs per CLK7 pixel.

### 1.5 WAIT comparison (`copper.vhd:94`)

```
if cvc == v and hc_ula >= h*8 + 12: PC++     // otherwise stay on the WAIT
```

- **v** is compared with `cvc`. So line 0 = the paper top row, plus NR $64. It is not "the line after the interrupt".
- **h** is in units of **8 CLK7 pixels** (8 normal pixels, 16 hi-res pixels). It is measured from the left paper edge: h=0 is paper x=0, h=31 is paper x=248, h=32 is the right border.
- The test is `>=`. So a WAIT reached late on the right line passes at once. A WAIT reached after its line has gone waits a whole frame.
- `hc_ula` maxes at 447/455. So h ≥ 55 (48K) or h ≥ 56 (128K) never matches on any line. [VHDL, derived]

### 1.6 NR $64: copper line offset

cvc is loaded with NR $64 at the paper top (`zxula_timing.vhd:462`). The offset applies to the copper, the line interrupt and NR $1E/$1F. A new value takes effect at the next paper top, up to 1 frame later. On reset it is 0 (`zxnext.vhd:5024`). Example: with offset 32, copper line 32 is ULA row 0.

---

## 2. Line interrupt

### 2.1 Registers

| NR | Bit | Write | Read |
|---|---|---|---|
| $22 | 7 | - | `not pulse_int_n`: **any** pulse-mode /INT currently asserted (`zxnext.vhd:5992`). The doc says "the ULA"; the VHDL says any source. |
| $22 | 2 | 1 = disable the ULA interrupt. This is the same bit as port $FF bit 6 and as NR $C4 bit 0 inverted (`zxnext.vhd:3619-3622`). | same |
| $22 | 1 | 1 = enable the line interrupt (alias of NR $C4 bit 1) | same |
| $22 | 0 | Line value bit 8 | same |
| $23 | 7:0 | Line value bits 7:0 | same |

On soft reset: line interrupt off, line value 0, ULA interrupt on.

### 2.2 Match (`zxula_timing.vhd:563-585`)

```
target = (line == 0) ? c_max_vc : line - 1
fire (one CLK7 pulse) when line_en and cvc == target and hc_ula == 255
```

- Same line numbering as the copper (cvc, with NR $64).
- It fires on the line **before** line N, at `hc_ula = 255`. That is paper x ≈ 243 of the previous line, about 13 pixels before its right paper edge. "The interrupt comes before line N is drawn."
- Line 0 fires on the last line of the frame (`c_max_vc`). A value above `c_max_vc` never fires.
- **How long it is held:** the source pulse lasts one CLK7 cycle. The /INT the CPU sees depends on the mode (§3.6, §3.7): 32 or 36 CPU clocks in pulse mode, and held until acknowledged in hardware IM2 mode.

---

## 3. Interrupt controller and hardware IM2

Files: `zxnext.vhd:1930-2045`, `device/peripherals.vhd`, `device/im2_peripheral.vhd`, `device/im2_device.vhd`, `device/im2_control.vhd`.

### 3.1 NR $C0: interrupt control (soft reset 0)

| Bit | Meaning |
|---|---|
| 7:5 | Top 3 bits of the IM2 vector |
| 4 | 0 |
| 3 | Stackless NMI |
| 2:1 | (Read only) the Z80's current IM mode: 00 = IM0, 01 = IM1, 10 = IM2. The hardware gets it by snooping `ED 46/4E/66/6E`, `ED 56/76` and `ED 5E/7E` (`im2_control.vhd:218-227`). |
| 0 | 0 = pulse (legacy) mode. 1 = hardware IM2 mode. |

### 3.2 NR $C2/$C3: NMI return address

- These always hold the address pushed during an NMI acknowledge. The core captures the bytes written in the NMIACK cycles (`zxnext.vhd:2055-2069`).
- If C0 bit 3 = 1, stackless NMI:
  - The NMI acknowledge does not write memory (MREQ is masked), but SP still goes −2.
  - The first RETN afterwards reads its 2 bytes from C2/C3 instead of memory (`cpu_di <= z80_retn_address`), and SP still goes +2.
  - After that RETN, it is off until the next NMI (`zxnext.vhd:2052, 2073-2085`).

### 3.3 Sources, priority, vectors

The priority index is also the vector index (`zxnext.vhd:1930-1999`):

| Index (priority, 0 = highest) | Source | Enable bit | Status bit | DMA-int bit | Vector (C0[7:5] = 0) |
|---|---|---|---|---|---|
| 0 | Line | C4 b1 | C8 b1 | CC b1 | $00 |
| 1 | UART0 Rx (avail or near full) | C6 b0 or b1 | CA b0/b1 | CE b0/b1 | $02 |
| 2 | UART1 Rx | C6 b4 or b5 | CA b4/b5 | CE b4/b5 | $04 |
| 3-10 | CTC 0-7 ZC/TO | C5 b0-7 | C9 b0-7 | CD b0-7 | $06,$08,...,$14 |
| 11 | ULA frame | C4 b0 | C8 b0 | CC b0 | $16 |
| 12 | UART0 Tx empty | C6 b2 | CA b2 | CE b2 | $18 |
| 13 | UART1 Tx empty | C6 b6 | CA b6 | CE b6 | $1A |
| last | Expansion bus /INT | C4 b7 | - | - | from the bus, or $FF |

```
vector = (C0 & 0xE0) | (index << 1)          // bit 0 is always 0
handler = word at (I << 8) | vector
```

Only CTC 0-3 exist (§4). Indexes 7-10 never fire.

### 3.4 NR $C4-$C6: enables

- **C4** (soft reset $81):
  - b7 = expansion bus /INT.
  - b1 = line.
  - b0 = ULA. Writing b0 sets port $FF b6 = NOT b0.
  - Reading gives `b7 & 00000 & line_en & ula_en` (`zxnext.vhd:6239`).
- **C5**: CTC 0-7 interrupt enables. A write sets bit 7 of each CTC channel's control register directly (`ctc_chan.vhd:270-271`). Reading returns the CTC enables. Bits 7:4 always read 0.
- **C6**:
  - b6 = UART1 Tx empty, b5 = UART1 Rx near full, b4 = UART1 Rx available.
  - b2 = UART0 Tx empty, b1 = UART0 Rx near full, b0 = UART0 Rx available.
  - Near full and available share one source. With the near-full enable on, the request is near-full only. Otherwise it is available (`zxnext.vhd:1942-1943`).

A source whose enable is 0 still sets its status bit. That is the "polled mode".

### 3.5 NR $C8-$CA: status (and NR $20)

- **C8**: b1 = line, b0 = ULA. **C9**: CTC 7:0.
- **CA**: b6 = UART1 Tx, b5 and b4 = UART1 Rx (the same bit, shown twice), b2 = UART0 Tx, b1 and b0 = UART0 Rx (the same bit, shown twice) (`zxnext.vhd:6254`).
- The status bit is set by the source's edge **whether or not it is enabled**, or by an NR $20 write (`im2_peripheral.vhd:160`).
- **Writing a 1 clears the bit.** In hardware IM2 mode it still reads 1 while the request is pending (not yet serviced). `status_read = status | im2_pending`.
- **NR $20** read: b7 = line, b6 = ULA, b3:0 = CTC 3:0 (aliases of the status bits).
- **NR $20** write: a 1 in b7/b6/b3:0 makes that interrupt happen now, **ignoring the enables** (`int_unq`, `zxnext.vhd:1946`).

### 3.6 Pulse (legacy) mode, C0 b0 = 0

```
for each source: on the rising edge of its request:
    status = 1
    if enabled (or forced by NR $20): start a pulse
pulse: /INT low for 32 CLK_CPU cycles (48K or +3 timing) or 36 (128K or Pentagon)
       (zxnext.vhd:2017-2045; counted in CPU clocks, so it is shorter in time at turbo speeds)
```

- Every source (ULA, line, CTC, UART) drives the **same** /INT pulse. The ISR tells them apart with C8-CA.
- In IM1 they all go to $0038.
- In IM2 no device answers the acknowledge. The data bus reads **$FF**, or expansion bus data (`zxnext.vhd:1869-1879`). So the handler pointer is read from `I*256+$FF`. The usual 257-byte table is the safe way to do it, but on a bare Next the vector is always $FF.
- RETI is not needed. The ISR clears the status bits itself if it uses them.
- [?] While the DMA holds the bus, the Z80 cannot take /INT. A pulse that starts and ends inside a long DMA burst is **lost**. This is inferred from the Z80 bus-request behaviour, not tested.

### 3.7 Hardware IM2 mode, C0 b0 = 1

Each source has a Zilog-style daisy-chain state machine (`im2_device.vhd:83-159`), clocked by CLK_CPU:

```
S_0   --(request latched, M1 high)-->         S_REQ
S_REQ --(M1 & IORQ low & IEI=1 & Z80 in IM2)--> S_ACK   ; drives /INT low while in S_REQ with IEI=1 and IM2
S_ACK --(M1 high)-->                          S_ISR   ; puts its vector on the bus
S_ISR --(RETI seen & IEI=1 & IM2)-->          S_0     ; then the pending request is cleared
IEO: S_0 -> IEI ; S_REQ -> IEI and reti_decode ; S_ACK/S_ISR -> 0
```

- **The request is held** (`im2_int_req`) from the source edge until the ISR ends (`im2_peripheral.vhd:167-178`). /INT stays low until it is acknowledged, so DI does not lose interrupts.
- While a device is in S_ISR, every lower-priority device is blocked (IEO = 0) **until its RETI**. A higher-priority device can still nest if the ISR does EI.
- **RETI is needed to re-arm.** RETN (ED 45) does not count.
- **How RETI is detected** (`im2_control.vhd`):
  - It snoops opcode fetches (M1 & MREQ). After `ED` comes `4D`, and `reti_seen` pulses at T4 of the `4D` fetch.
  - CB, DD and FD prefixes are tracked, so that operand or displacement bytes are never taken as ED.
  - It then waits 2 more CPU clocks (S_SRL_T1/T2) before `dma_delay` drops.
- **Z80 not in IM2** (IM0/IM1) while C0 b0 = 1:
  - `o_int_n` is gated by `i_im2_mode`, so line, CTC and UART **never interrupt**. Their requests stay pending until IM2 is set.
  - **The ULA is the exception** (`EXCEPTION => "...100000000000"`, `im2_peripheral.vhd:192`). In hardware IM2 mode with the Z80 not in IM2, the ULA makes a normal 32/36-cycle pulse (so IM1 still works for the frame interrupt).
- **ULA in true hardware IM2** (C0 b0 = 1 and the Z80 in IM2): it **does** give a vector, `C0[7:5] | $16`. **The earlier note ("the ULA gives no vector; needs a 257-byte table") is wrong for hardware IM2 mode. It is right only for pulse mode with IM2.**
- The expansion bus is the lowest priority. With no external vector, $FF is read.

### 3.8 NR $CC-$CE: DMA interrupt enables (soft reset 0)

- **CC**: b7 = NMI, b1 = line, b0 = ULA.
- **CD**: CTC 7:0.
- **CE**: the UARTs, laid out as in C6.

They work **only in hardware IM2 mode**. The DMA is stopped while a device whose CC-CE bit is set is in S_REQ, S_ACK or S_ISR (`im2_device.vhd:151`), until its RETI plus 2 clocks (`zxnext.vhd:2001-2010`). See §5.7.

---

## 4. CTC

Files: `device/ctc.vhd`, `device/ctc_chan.vhd`, `zxnext.vhd:2690, 4064-4100`.

- **Ports $183B-$1F3B**: a write needs `A15:11 = 00011` and low byte $3B. The channel is `A10:8`.
- **Only 4 channels exist (0-3)** (`NUM_CTC => 4`, `zxnext.vhd:4067`). Writes to $1C3B-$1F3B are ignored. Reads there return $00. [VHDL; the port is still decoded]
- **Clock: CLK28** (`i_CLK => i_CLK_28`). It is not the CPU clock and it does not follow turbo speed. Its exact rate follows NR $11.
- **Read**: the current down-counter value.

### 4.1 Writes to a channel (`ctc_chan.vhd:198-289`)

```
if waiting for a time constant (S_RESET_TC or S_RUN_TC): byte = time constant
elif bit0 == 1: byte = control word
else:           byte = vector (ignored: o_vector_wr is open)
```

Control word:

| Bit | Meaning |
|---|---|
| 7 | Interrupt enable (also set by NR $C5) |
| 6 | 0 = timer, 1 = counter |
| 5 | Timer prescaler: 0 = /16, 1 = /256 |
| 4 | CLK/TRG edge: 0 = falling, 1 = rising. Changing it counts as an edge. |
| 3 | Timer trigger: 0 = start as soon as the TC is loaded, 1 = wait for a CLK/TRG edge |
| 2 | A time constant follows |
| 1 | Software reset |
| 0 | 1 = this is a control word |

The state machine has five states: `S_RESET`, `S_RESET_TC`, `S_TRIGGER`, `S_RUN` and `S_RUN_TC`.

- After a hard reset the channel is stopped. It needs a control word with D2 = 1, then a TC.
- **D1 = 1 with D2 = 0**: the channel stops (S_RESET).
- **D1 = 1 with D2 = 1**: it stops, waits for a TC, then runs.
- **D2 = 1 without D1** while running: a new TC is loaded on the next reload, and counting goes on.
- A soft reset while the channel waits for a TC is taken as the TC (Zilog clarification 5).

### 4.2 Counting

```
prescaler p: free-running 8-bit counter on CLK28, cleared while not running
tick_timer   = (p[3:0] == 15)                         ; /16
             or (p[7:0] == 255)                       ; /256
tick_counter = selected edge of CLK/TRG
on tick: if t - 1 == 0 (and running): ZC/TO = 1 for one CLK28, t = TC
         else t = t - 1
```

- TC 0 means 256.
- **Timer period** = prescaler × TC / CLK28. So the frequency = CLK28 / (16 or 256) / TC. Example: 28 MHz /16 /175 = 10 kHz.
- **Chaining is fixed in hardware**:
  - `clk_trg(n) = ZC/TO(n-1)`, and channel 0 takes ZC/TO(3) (`zxnext.vhd:4084`). So it is a ring 3→0→1→2→3.
  - Counter mode on channel n counts the ZC/TO pulses of channel n−1.
  - There is no external CLK/TRG input.
- ZC/TO is a one-CLK28 pulse, delayed one clock (`ctc_chan.vhd:170-183`). It also drives the interrupt source (§3.3, indexes 3-6).
- Channel 3's ZC/TO also toggles joystick pin 7 in joystick I/O clock mode (NR $0B).

### 4.3 Interrupt vector

The CTC's own vector register is **not used**. In hardware IM2 mode the vector is `C0[7:5] | (3+n)<<1`: $06, $08, $0A, $0C for channels 0-3. In pulse mode it is the shared pulse (§3.6).

---

## 5. zxnDMA

Files: `device/dma.vhd` (the entity `z80dma`) and `zxnext.vhd:1773-1835`.

### 5.1 Ports and mode

- **$6B** = zxnDMA. **$0B** = Zilog-compatible.
- Both are decoded on the low byte only.
- **Every read or write sets the mode** from the port used (`zxnext.vhd:1811-1818`).
- The mode changes **only** the byte-counter preload (§5.5).
- The DMA runs on **CLK_CPU** (the CPU clock at the current speed, stretched by contention).

### 5.2 Register writes (the decode is in `dma.vhd:509-892`)

All base bytes are decoded in the IDLE write state:

| WR | Base byte | Fields used | Bytes that follow, in order (each present if its flag bit is set) |
|---|---|---|---|
| WR0 | `0 b6 b5 b4 b3 D x x`, bits 1:0 ≠ 00 | D = b2: 1 = A→B, 0 = B→A | b3: A addr lo. b4: A addr hi. b5: length lo. b6: length hi. |
| WR1 | `0 b6 m m io 1 0 0` | io (b3): 1 = port A is I/O. mm (b5:4): 00 = decrement, 01 = increment, 1x = fixed | b6: timing byte. Its bits 1:0 = cycle length (00 = 4, 01 = 3, 10 = 2, 11 = 4). If the timing byte has b5 set, a prescaler byte follows **and is ignored** for port A. |
| WR2 | `0 b6 m m io 0 0 0` | the same, for port B | b6: timing byte. If the timing byte has b5 set, the **zxn prescaler byte** follows (used). |
| WR3 | `1 b6 x b4 b3 x 0 0` | b6 = 1 → **enable (start) now** | b3: mask byte (ignored). b4: match byte (ignored). |
| WR4 | `1 m m b4 b3 b2 0 1` | mm (b6:5): 00 = byte, 01 = continuous, 10 = burst, 11 = like continuous | b2: B addr lo. b3: B addr hi. |
| WR5 | `1 0 r c x 0 1 0` | b5 = auto-restart. b4 = CE/WAIT (stored, unused) | none |
| WR6 | `1 x x x x x 1 1` | a command | $BB is followed by a read-mask byte |

Quirks [VHDL]:

- **WR4 bit 4 (interrupt control):**
  - If B lo or B hi also follows, it is ignored.
  - If WR4 has b4 = 1 and **b2 = b3 = 0**, the write state machine goes to `R4_BYTE_2`. That state has no handler (`when others => null`), so **every later write is swallowed until a hard reset**. This looks like a bug. Never send it.
- Writes of the form `11xxx010` or `1xxxx110` (not WR5) are ignored.
- The DMA ignores port writes while it holds the bus (`zxnext.vhd:2768-2769`).
- Hard reset defaults:
  - WR4 mode = 01 (continuous). Both timings = 01 (3 cycles). Prescaler = 0. No auto-restart. Read mask = $7F.
  - Addresses and length are **not** reset.

### 5.3 WR6 commands (`dma.vhd:637-732`)

| Byte | Command | Effect in the core |
|---|---|---|
| $C3 | RESET | Go to IDLE (releases the bus). E and T flags reset. Timings = 3 cycles, prescaler = 0, auto-restart off, CE/WAIT off. The mode, addresses, length and read mask are kept. |
| $C7 | Reset port A timing | Port A timing = 01 |
| $CB | Reset port B timing | Port B timing = 01 |
| $CF | LOAD | src/dst = A/B start addresses (by direction), counter = 0 (zxn) or $FFFF (Zilog), E flag cleared |
| $D3 | CONTINUE | counter = 0 or $FFFF. The addresses are **kept**. E flag cleared. |
| $87 | ENABLE | Go to START_DMA. It does not LOAD. |
| $83 | DISABLE | Go to IDLE at once |
| $BF | READ STATUS | The next read is the status byte |
| $8B | Reinit status | E and T flags cleared |
| $A7 | Initialize read sequence | Restart the read sequence at the first item set in the mask |
| $BB | READ MASK | The next byte is the mask: b0 status, b1 counter lo, b2 counter hi, b3 A lo, b4 A hi, b5 B lo, b6 B hi |
| $AF, $AB, $A3, $B7, $B3 | Interrupt and force-ready commands | Accepted, **no effect** (the DMA has no interrupts) |

### 5.4 Read-back (`dma.vhd:895-1140`)

Each port read returns the current item, then moves to the next item set in the mask, in a cycle:

```
status, counter lo, counter hi, A lo, A hi, B lo, B hi, then back to status
```

- **Status byte** = `00 E̅ 1 1 0 1 T` = `$1A | (E̅<<5) | T`.
  - E̅ = 0 once the end of the block is reached.
  - T = at least one byte transferred, **but T is cleared on every cycle in IDLE** (`dma.vhd:265`). So after a finished transfer the status reads **$1A**. After a reset or LOAD it reads $3A. During a burst-mode gap it reads $3B.
- **Counter** = the number of bytes transferred so far. It counts up from 0 (or from $FFFF in Zilog mode). It is not the bytes remaining.
- **A and B** = the **current** addresses (port A is src or dst, depending on the direction).

### 5.5 Transfer engine (`dma.vhd:258-497`)

```
START_DMA:   if dma_delay: release the bus and wait; else BUSREQ = 0, go to WAITING_ACK
WAITING_ACK: wait for the Z80's BUSAK, then READ
READ   (src, MREQ or IORQ):  2/3/4 CLK_CPU per the source port's timing (+ waits); timer = 0 at its start
WRITE  (dst):                2/3/4 CLK_CPU per the dest port's timing (+ waits); counter++, src/dst step by mode
after the write:
   if prescaler != 0 and timer/32 < prescaler: WAITING_CYCLES
   elif counter < length: dma_delay ? START_DMA : READ
   else FINISH
WAITING_CYCLES: in burst mode (WR4=10), release BUSREQ (the CPU runs); in any other mode, keep the bus (the CPU stays stopped)
                when timer/32 >= prescaler: counter < length ? (bus released ? START_DMA : WAITING_ACK) : FINISH
FINISH: E̅ = 0; auto-restart ? reload the addresses and the counter (like LOAD) and go on : IDLE
```

- **The CPU is stopped** (BUSREQ/BUSAK) for the whole block in continuous mode. In burst mode it is stopped only during each byte.
- **Cycles per byte** = read length + write length. The default is 3 + 3 = **6 CLK_CPU**. With 2-cycle timing it is 4. Add:
  - 1 wait state per memory read at 28 MHz (`sram_wait_n`, `zxnext.vhd:3175`).
  - Any contention. [?] The CPU clock is stretched, so DMA accesses to contended memory at 3.5 MHz probably stretch too. Not checked.
- Bus pickup costs START_DMA (1 clock) plus the Z80's BUSREQ latency (the end of its current M-cycle) plus 1 or more clocks.
- **Length** [VHDL]:
  - **zxn mode**: the counter starts at 0 and the loop runs while `counter < length` after each byte. So it moves **max(length, 1)** bytes. Length 0 moves 1 byte.
  - **Zilog mode**: the counter starts at $FFFF. It moves **length + 1** bytes. Length $FFFF moves 65536.
- Fixed addressing = mode `1x`. A transfer to an I/O port with a fixed address is the normal set-up for audio.

### 5.6 Prescaler and burst rate

- `DMA_timer` adds 8, 4, 2 or 1 per CLK_CPU at 3.5, 7, 14 or 28 MHz. So it always counts **CLK28 ticks**, whatever the CPU speed (`dma.vhd:250-255`).
- The compare uses `timer[13:5]`, so one prescaler unit = 32 CLK28 = 1.143 µs.

```
byte period ≈ prescaler × 32 / CLK28     (measured from the start of each byte's READ)
rate ≈ 875 kHz / prescaler   (CLK28 = 28 MHz)   e.g. P=55 → 15.9 kHz, P=110 → 7.95 kHz, P=20 → 43.75 kHz
```

- [?] In burst mode the bus re-pickup (START_DMA, WAITING_ACK and the Z80's latency) comes **after** the timer expires, and the timer is reset only at the next READ. So the real period is the formula plus about 2-6 CPU clocks. The rate is a little below nominal.
- In continuous mode the prescaler still paces the bytes, but the CPU stays stopped.
- Prescaler 0 means no pacing.
- [?] The timer counts CLK_CPU edges. If contention stretches CLK_CPU at 3.5 MHz, the pacing drifts slightly.

### 5.7 Interrupts and the DMA

- **Pulse mode**: the DMA cannot be interrupted, and /INT pulses that happen during it can be lost (§3.6).
- **Hardware IM2 mode**: when a source set in CC-CE is pending, `im2_dma_delay` = 1. At the next byte boundary the DMA goes to START_DMA and **releases the bus**. The CPU then takes the interrupt and runs the ISR. The DMA stays off until RETI plus 2 clocks.
- With CC bit 7, an NMI does the same.
- nextreg.txt: "each time the dma is interrupted one instruction of progress is made in the main program".
- The DMA itself **never makes an interrupt**. At the end there is only the status E bit, or auto-restart (WR5 b5) loops for ever with no gap other than the prescaler.

### 5.8 Examples

Memory to memory, 256 bytes from $8000 to $C000 (send to port $6B, in order):

```
$83                 ; DISABLE
$7D                 ; WR0 01111101: A->B, transfer; A lo, A hi, len lo, len hi follow
$00 $80             ; port A = $8000
$00 $01             ; length = $0100 (zxn: 256 bytes; Zilog/$0B: 257)
$54 $02             ; WR1 01010100: A = memory, increment, timing follows; 2-cycle
$50 $02             ; WR2 01010000: B = memory, increment, timing follows; 2-cycle, no prescaler
$AD                 ; WR4 10101101: continuous, B lo and B hi follow
$00 $C0             ; port B = $C000
$82                 ; WR5 10000010: stop at the end (no auto-restart)
$CF                 ; LOAD
$87                 ; ENABLE: the CPU stops, 256 x (2+2) clocks, then it resumes
```

Sample playback to the SpecDrum DAC at about 15.9 kHz, looping:

```
$83, $7D, lo(src), hi(src), lo(len), hi(len)
$54 $02             ; A = memory, increment
$68 $22 $37         ; WR2 01101000: B = I/O, fixed, timing follows; timing $22 = 2-cycle + prescaler follows; prescaler $37=55
$CD $DF $00         ; WR4 11001101: burst, B = port $00DF
$A2                 ; WR5: auto-restart
$CF, $87
```

---

## 6. Sound

Files: `audio/turbosound.vhd`, `audio/ym2149.vhd`, `audio/soundrive.vhd`, `audio/audio_mixer.vhd`, `zxnext.vhd:2647-2778, 6379-6540`.

### 6.1 AY / TurboSound ports

- **$FFFD** decode: `A15:14 = 11`, `A2 = 1`, `A1:0 = 01`.
- **$BFFD** decode: `A15:14 = 10`, `A2 = 1`, `A1:0 = 01`.
- **$BFF5** decode: $BFFD with `A3 = 0`.
- **$DFFD takes precedence** over $FFFD for writes.

**$FFFD write** (`turbosound.vhd:120-142`):

```
if d[7:5] == 000:                               select register d[4:0] in the active AY
elif turbosound_en (NR $08 b1) and d[7]==1 and d[4:2]==111:
    chip = d[1:0]: 11 -> AY0, 10 -> AY1, 01 -> AY2, 00 -> AY0 (the 'others' case)
    pan(chip) = d[6:5]   ; b6 = left on, b5 = right on (reset: both on)
    active = chip
else: ignored
```

- **$BFFD write**: data to the active AY's selected register.
- **$FFFD read**: the active AY's selected register. $BFFD reads the same, but only with +3 timing.
- **$BFF5 read**: `chipID[1:0] (11/10/01) & 0 & reg[4:0]` (`ym2149.vhd:221`).

Read masking:

- **AY mode**: the unused high bits of R1, R3, R5 (b7:4), R6 and R8-R10 (b7:5) and R13 (b7:4) read 0.
- **YM mode**: all 8 bits read back, and registers 16-31 read $FF.
- R14/R15 read `reg AND $FF` (no I/O port is connected).

Chips and clock:

- The AY clock is CLK28/16 = **1.75 MHz**. Its internal /8 is AY-compatible.
- **Turbosound off**: only the active chip is heard, and the selection is frozen. The other chips keep running but are muted (`turbosound.vhd:197-205`).

### 6.2 NR $06, $08, $09 (sound bits)

| NR | Bit | Meaning |
|---|---|---|
| $06 | 1:0 | 00 = YM, 01 = AY, 10 = "ZXN-8950", 11 = hold all AYs in reset. The core uses only bit 0 as AY/YM (`aymode_i => nr_06_psg_mode(0)`), so **10 behaves as YM** [VHDL]. |
| $06 | 6 | Beeper only to the internal speaker. Takes effect only if NR $08 b4 = 1 too. |
| $08 | 5 | Stereo for all AYs: 0 = ABC, 1 = ACB |
| $08 | 4 | Internal speaker enable (hard reset 1) |
| $08 | 3 | DAC enable. When 0 the DACs are **held in reset at $80** (`zxnext.vhd:6436`), and the ports and the NR $2C-$2E mirrors do nothing. |
| $08 | 1 | Turbosound enable |
| $09 | 7/6/5 | AY2/AY1/AY0 mono |

### 6.3 AY channel mixing (per chip, `turbosound.vhd:186-190`)

| Mode | L | R |
|---|---|---|
| ABC | A + B | C + B |
| ACB | A + C | B + C |
| Mono | A + B + C | A + B + C |

- Channel level: in AY mode, a 16-entry table indexed by `level[4:1]` (`$00,03,04,06,0A,0F,15,22,28,41,5B,72,90,B5,D7,FF`). In YM mode, a 32-entry table. Each is 0-255.
- Each chip's L/R is masked by its pan bits.
- `ay_L = sum over the 3 chips`. It is a 12-bit value, 0-2295.

### 6.4 DACs

There are 4 channels, A, B, C and D. They are unsigned 8-bit, with a reset value of $80. **L = A + B, R = C + D** (0-510, `soundrive.vhd:112-113`). Ports are decoded on the **low byte only** and are write-only. A write needs NR $08 b3 = 1 **and** the port's enable in NR $82-$85.

| Port | Channel(s) | Origin | NR $82-$85 enable bit |
|---|---|---|---|
| $1F | A | Soundrive mode 1 | 17 |
| $0F | B | Soundrive 1 / Covox | 17 or 20 |
| $4F | C | Soundrive 1 / Covox | 17 or 20 |
| $5F | D | Soundrive 1 / Profi | 17 or 19 |
| $F1 | A | Soundrive mode 2 | 18 |
| $F3 | B | Soundrive mode 2 | 18 |
| $F9 | C | Soundrive mode 2 | 18 |
| $FB | D (sd2 on); A + D (sd2 off: Pentagon/ATM) | | 18 / 21 |
| $3F | A | Profi Covox | 19 |
| $DF | A + D | SpecDrum | 23 |
| $B3 | B + C | GS Covox | 22 |

- With all enables on (the default), **$FB writes D only**, not A + D (`zxnext.vhd:2433`).
- With bit 18 on, writes to any port with low byte **$F1 or $F9 never reach $7FFD, $DFFD, $1FFD or $3FFD**, **even if the DACs are disabled** (`port_fd_conflict_wr`, `zxnext.vhd:2708-2725`).

NextReg mirrors (writable by the copper too):

- **$2C** → B (left).
- **$2D** → A and D (both).
- **$2E** → C (right).
- Reads return Pi I2S sample data, not the DAC values.

### 6.5 Mixer (`audio_mixer.vhd:79-100`)

All unsigned, summed per side into 13 bits (0-8191):

| Source | Level |
|---|---|
| Beeper (port $FE b4) | 512 when 1 |
| MIC (port $FE b3, XOR tape-in) | 128 when 1 |
| AY | 0-2295 (one channel at full = 255) |
| DAC side | (A + B) × 4: 0-2040 (one channel at full = 1020) |
| Pi I2S | 0-1023 |

- With NR $06 b6 and NR $08 b4 both set, the beeper and MIC are left out of this mix and go to the internal speaker only.
- Everything is unsigned, so the DACs at rest add a DC offset of 1024 per side.

### 6.6 Port clashes with Kempston

- **$1F**: a **read** is Kempston 1 / MD1, when some joystick is set to Kempston 1 or MD1. A **write** is DAC A (Soundrive 1). The directions do not clash. NR $08 b3 only turns the DAC side on or off.
- **$DF**: a **write** is SpecDrum (A + D). A **read** is a Kempston-1 alias **only if the mouse ports are disabled** (enable bit 13 = 0) and bit 23 is on (`zxnext.vhd:2674`).
- **$3F / $1F (writes)**: these are also Multiface enable/disable ports for some MF types (NR $0A). [?] The precedence was not traced.

---

## 7. Input

### 7.1 NR $05 joystick modes

```
NR $05: b7:6 = joy1[1:0], b5:4 = joy2[1:0], b3 = joy1[2], b2 = 50/60 Hz, b1 = joy2[2], b0 = scandoubler
joy1 = {b3, b7, b6}    joy2 = {b1, b5, b4}      (zxnext.vhd:5157-5158)
```

| Code | Mode |
|---|---|
| 000 | Sinclair 2 (keys 1-5) |
| 001 | Kempston 1 (port $1F) |
| 010 | Cursor (5, 6, 7, 8, 0) |
| 011 | Sinclair 1 (keys 6-0) |
| 100 | Kempston 2 (port $37) |
| 101 | MD 1 (port $1F) |
| 110 | MD 2 (port $37) |
| 111 | User-defined keys (set through NR $28/$29/$2B, 12 bytes: MODE X Z Y START A C B U D L R, each byte `row<<3 | col`, $07 = none) |

Defaults: joy1 = 001 (Kempston 1), joy2 = 000 (Sinclair 2) (`zxnext.vhd:1105-1106`).

### 7.2 Kempston / MD ports $1F and $37 (low-byte decode, active high)

The pad inputs are `MODE X Z Y START A C B U D L R` = bits 11..0 (`zxnext.vhd:90`).

| Bit | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |
|---|---|---|---|---|---|---|---|---|
| Kempston | 0 | 0 | Fire 2 | Fire 1 | Up | Down | Left | Right |
| MD mode | START | A | C | B | Up | Down | Left | Right |

- Bits 7:6 are only filled in MD mode (`zxnext.vhd:3478-3491`).
- If both joysticks map to the same port, the values are **ORed**.
- If no joystick maps to a port, the port is not decoded at all (`port_1f_hw_en`), so the read falls through to the expansion bus or $FF.
- **X, Y, Z and MODE are not on the ports.** They are in NR $B2.

**NR $B2** (`zxnext.vhd:6215`):

| Bit | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |
|---|---|---|---|---|---|---|---|---|
| Pad | R X | R Z | R Y | R MODE | L X | L Z | L Y | L MODE |

1 = pressed. L = joystick 1 (left connector), R = joystick 2.

### 7.3 Kempston mouse

Decoded with low byte $DF and `A11:8`, so any `A15:12` works. All are read-only.

| Port | Value |
|---|---|
| $FBDF | X, 0-255, wraps; **increases to the right** |
| $FFDF | Y, 0-255, wraps; **increases upwards** (PS/2 sign convention) |
| $FADF | `b7:4 = wheel (4-bit, wraps)`, `b3 = 1`, `b2 = middle`, `b1 = left`, `b0 = right`. **The VHDL inverts the buttons: 0 = pressed** (`zxnext.vhd:3560`: `'1' & not mid & not left & not right`). This is like the original Kempston mouse. **ports.txt says "1 = pressed". The VHDL disagrees, so trust the VHDL.** [VHDL; not checked on hardware] |

- The wheel is the low 4 bits of a counter that adds the PS/2 Z delta. [?] Which way it moves on scroll up was not checked.

**NR $0A mouse bits:**

- **b3** swaps left and right at the PS/2 decoder (`ps2_mouse.v:180-183`).
- **b1:0** is the DPI. It scales each 8-bit PS/2 delta before adding it (`ps2_mouse.v:171-177`):

| b1:0 | Name | Scaling |
|---|---|---|
| 00 | "low" | ×2 |
| 01 | default (hard reset) | ×1 |
| 10 | "medium" | ÷2 (arithmetic) |
| 11 | "high" | ÷4 |

The PS/2 overflow and 9th sign bits are ignored.

### 7.4 Extended keyboard (Next PS/2 or membrane keys)

These are read-only, with 1 = pressed:

| NR | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |
|---|---|---|---|---|---|---|---|---|
| $B0 | ; | " | , | . | UP | DOWN | LEFT | RIGHT |
| $B1 | DELETE | EDIT | BREAK | INV VIDEO | TRUE VIDEO | GRAPH | CAPS LOCK | EXTEND |

- Normally these keys also make their Spectrum shift combinations in the 8×5 matrix.
- **NR $68 b4 = 1** stops that, and they then show only here.

---

## 8. Open points / not confirmed

1. **Paper position against `hc_ula`.** The +12 offset in both the copper WAIT and the ULA counter suggests paper x = 0 at hc_ula = 12. The exact on-screen pixel, after the video pipeline delays, was not traced in `zxula.vhd`.
2. **DMA and contention**, and the exact BUSREQ latency of the T80 core. The DMA cycle counts above leave out contention.
3. **Burst-mode rate.** The pickup overhead is added to each prescaler period (inferred from where the timer is reset).
4. **Lost pulse-mode interrupts during a long DMA** (inferred).
5. **Mouse button polarity.** VHDL: 0 = pressed. ports.txt: 1 = pressed.
6. **NR $22 b7.** VHDL: any pulse /INT. Doc: the ULA.
7. **Wheel direction.** The precedence between Multiface ports $1F/$3F and the DAC writes.
8. **NR $06 mode 10 ("ZXN-8950")**: no separate behaviour exists in this core.
9. **The WR4 "interrupt control only" write that wedges the DMA**: it looks like a bug in the core. Real boards running this core would do the same.

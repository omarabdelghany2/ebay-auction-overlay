# Live Auction Battle Overlay

An animated overlay for eBay Live auctions. The current **top bidder** stands on
screen as a fighter showing their username + bid. A **higher bid** sends a
challenger in who **defeats the leader and takes their place**. If the same
person keeps the lead (e.g. a max bid auto-countering others), a **COMBO** streak
builds. When the auction ends, the leader is crowned **WINNER**. Runs in OBS as a
Browser Source.

Previews: `references/overlay-takeover-preview.png`, `references/overlay-winner-preview.png`

## Try the demo

Open `index.html` in a browser (keep the whole folder together).

- **NEW BIDDER** — a challenger takes the lead (defeats the current leader)
- **Leader re-bids / max-bid hold** — same leader holds → **COMBO +1**
- **Rapid bids** — a burst of bidders
- **End auction 🏆** — crown the winner
- **Auto** — hands-free bidding war
- Keys: `space` new bid · `C` combo · `W` winner · `D` hide panel

## URL options

| Param        | Effect                                                   |
|--------------|----------------------------------------------------------|
| `?bg=0`      | Transparent background (OBS overlay over your stream)    |
| `?demo=0`    | Hide the simulator panel (live use)                      |
| `?auto=1700` | Auto-fire bids every N ms (hands-free demo)              |
| `?ws=URL`    | Connect to the live bid feed (see `../server`)           |
| `?pose=clash` / `?pose=winner` | Freeze a frame (for screenshots)      |

Live OBS use: `index.html?bg=0&demo=0&ws=ws://localhost:8787`

## Characters (placeholder)

Two fighter skins — **"Luffy"** (warm) and **"Zoro"** (green) — alternate between
the leader and challenger. They're currently a free placeholder sprite
(GameArt2D "Ninja Adventure", CC0) tinted into two looks. **Final delivery uses
custom Luffy/Zoro pixel art** (see `references/` for the style direction).

### Swapping in the real Luffy / Zoro art

Edit the `SKINS` / `ANIMS` block near the top of the script in `index.html`:

```js
const SKINS = {
  luffy: { base: "assets/luffy/", filter: "none" },   // point at real frames
  zoro:  { base: "assets/zoro/",  filter: "none" },
};
```

Drop each character's frames into `assets/luffy/` and `assets/zoro/`, set the
`ANIMS` prefixes / frame counts / fps, and the foot `anchor` per animation. No
other code changes — all the battle logic, combos, and winner screen keep working.

## Feeding bids from code (what the server calls)

```js
AuctionOverlay.bid({ username: "hardworker706", amount: 42 });
AuctionOverlay.endAuction();
// or window.postMessage({ type:"bid", username:"anne", amount:12 }, "*")
```

For the live data side (eBay → WebSocket → this overlay), see **`../server`**.

> This is a **folder** (`index.html` + `assets/`). To send it or load it in OBS,
> keep the files together — zip the whole `overlay/` folder.

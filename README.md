# eBay Live Auction Battle Overlay

An animated OBS overlay for eBay Live auctions. The current top bidder stands on
screen as a fighter with their username + bid; a higher bid sends a challenger
in to defeat and replace them; holding the lead builds a combo; the auction ends
with a winner screen. Bids arrive **automatically from eBay** in real time.

```
eBay (BidReceived)  ->  server  ->  WebSocket  ->  overlay in OBS
```

## Repo layout
- **`overlay/`** — the overlay (single-file `index.html` + sprite assets). OBS Browser Source.
- **`server/`** — Node service: serves the overlay, bridges eBay bids over WebSocket,
  and handles eBay authorization + notifications.
- **`render.yaml`** — one-click cloud deploy (Render Blueprint).
- **`DEPLOY.md`** — step-by-step hosting + eBay setup.

## Run locally
```bash
cd server
npm install
npm run simulate         # fake bidding war, no eBay needed
```
Open **http://localhost:8787/** (control panel) and
**http://localhost:8787/overlay/index.html** (the overlay).

## Deploy / go live
See **[DEPLOY.md](DEPLOY.md)**.

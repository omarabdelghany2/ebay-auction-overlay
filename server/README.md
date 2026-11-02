# Auction Overlay Server

The live-data bridge. It takes bid events from a source (eBay webhook / API, or a
manual/test feed) and pushes them to the overlay over WebSocket in real time.

```
bid source  ->  this server  ->  (WebSocket)  ->  overlay in OBS
```

## Run

```bash
cd server
npm install
npm start            # just the bridge, on http://localhost:8787
npm run simulate     # bridge + a fake bidding war (to see it all working)
```

Then point the overlay at it:

```
index.html?ws=ws://localhost:8787
```

(In OBS, put that full URL in the Browser Source.) Open the overlay, run
`npm run simulate`, and you'll see fake bidders fighting on the overlay — this
proves the live pipeline before eBay is even connected.

## Endpoints

| Method | Path             | Purpose                                                        |
|--------|------------------|----------------------------------------------------------------|
| WS     | `ws://host:8787` | The overlay connects here; receives every bid                  |
| POST   | `/bid`           | Manual/test bid: `{ "username":"anne", "amount": 12 }`         |
| POST   | `/end`           | End the auction (triggers the WINNER screen)                   |
| POST   | `/ebay/webhook`  | Receives eBay notifications                                     |
| GET    | `/ebay/webhook?challenge_code=…` | eBay endpoint-verification handshake           |
| GET    | `/`              | Status (how many overlays are connected)                       |

Quick test without eBay:

```bash
curl -X POST localhost:8787/bid -H 'content-type: application/json' \
     -d '{"username":"anne","amount":12}'
curl -X POST localhost:8787/bid -H 'content-type: application/json' \
     -d '{"username":"john","amount":20}'   # john's character defeats anne
curl -X POST localhost:8787/end             # crown the winner
```

## Connecting eBay (go-live steps)

eBay's **`BidReceived`** platform notification fires to the seller when a bid is
placed on their auction; `server.js` already parses that payload (SOAP/XML),
pulls out the high bidder + current price, and forwards it to the overlay. To
turn it on for real auctions:

1. **Create an eBay developer account** at https://developer.ebay.com and make a
   keyset → gives you `EBAY_APP_ID`, `EBAY_DEV_ID`, `EBAY_CERT_ID`.
2. **Get the seller's auth token** (Wesley grants access) → `EBAY_AUTH_TOKEN`.
3. **Expose the server publicly** so eBay can reach it. Easiest in dev:
   `ngrok http 8787` → use the https URL it prints as `EBAY_ENDPOINT_URL`
   (+ `/ebay/webhook`).
4. Fill in `.env`, then **subscribe**: `npm run subscribe`. This calls
   `SetNotificationPreferences` so eBay starts POSTing `BidReceived` to your URL.
5. **Test on one of his real live auctions** — place a bid, watch it appear.

With the app keys set, incoming notifications are **signature-validated**
(`Base64(MD5(Timestamp+DevID+AppID+CertID))`).

⚠️ **The one thing to confirm live (already flagged to the client):** high-bidder
usernames are sometimes **anonymised** by eBay. As the auction *owner* Wesley
normally sees the real bidder, but we verify this on the first live test. If a
username isn't in the notification, `extractBidFromEbay()` in `server.js` is the
single place to adapt (e.g. follow up with a Trading API `GetItemTransactions`
call), and any other source can still POST to `/bid` unchanged.

## Env

Copy `.env.example` to `.env` and fill in when wiring eBay. Not needed for
local/simulate use.

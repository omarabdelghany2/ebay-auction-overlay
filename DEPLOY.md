# Deploy & Go Live

The whole thing runs as **one cloud service** (Render). It serves the overlay AND
receives eBay bids. Once it's up, **Wesley installs nothing** — he pastes one URL
into OBS and clicks "Connect eBay" once.

```
eBay (BidReceived)  ->  Render service  ->  WebSocket  ->  overlay in his OBS
```

## A. Deploy to Render (one time)

1. Push this repo to GitHub (done).
2. On **render.com** → **New + → Blueprint** → connect this repo (or paste its
   public URL). Render reads `render.yaml` and creates the service.
3. First deploy gives a URL like `https://auction-overlay.onrender.com`.
4. In Render → the service → **Environment**, set:
   - `PUBLIC_URL` = that Render URL
   - `EBAY_APP_ID`, `EBAY_DEV_ID`, `EBAY_CERT_ID` = your eBay app keys (step B)
   - `EBAY_RUNAME` = your RuName (step B)
   - (`EBAY_ENV` is already `production`)
   Save → it redeploys.

> Render's **free** plan sleeps after 15 min idle (first bid after waking is
> delayed ~30s). For live auctions use the **Starter** plan (always-on) or a
> keep-alive ping.

## B. eBay app (one time, ~10 min — you, not Wesley)

1. Create a free account at **developer.ebay.com** → create a keyset →
   gives `EBAY_APP_ID`, `EBAY_DEV_ID`, `EBAY_CERT_ID`.
2. Create a **RuName** (Redirect URL) with:
   - Auth **accepted** URL → `<PUBLIC_URL>/ebay/accepted`
   - Auth **declined** URL → `<PUBLIC_URL>/ebay/declined`
   Put the RuName value in `EBAY_RUNAME`.

## C. Connect the seller + go live

1. Open `<PUBLIC_URL>/` → click **Connect eBay** → sign in as the **seller
   (Wesley)** → **Agree**. The token is saved and bid notifications are
   auto-subscribed.
2. (persistence) Copy the token from the Render **Logs** into the
   `EBAY_AUTH_TOKEN` env var so it survives restarts.
3. **Wesley adds to OBS:** Browser Source →
   `<PUBLIC_URL>/overlay/index.html?bg=0&demo=0` → 1280×720.
4. Test on a real auction: place a bid → it appears on the overlay.

## Who owns the Render account?

- **Simplest:** you deploy it on your Render, Wesley just gets the OBS URL. But you
  keep paying/maintaining hosting.
- **Wesley hosts it (his Render account):** he deploys the public repo via Blueprint
  and you finish the settings together. Note the eBay app keys are **yours** — either
  you share the key values for his Render env vars, or he creates his own eBay app.

## The one thing to confirm live

On the first live bid, verify the bidder **username** comes through (eBay sometimes
anonymises bidders; as the auction owner Wesley normally sees the real name). If a
name is missing, `extractBidFromEbay()` in `server/server.js` is the one place to
adjust.

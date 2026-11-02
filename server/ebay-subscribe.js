// =============================================================================
//  ebay-subscribe.js  —  one-time setup: tell eBay to deliver BidReceived
//  notifications (and friends) to our public webhook URL.
//
//  Run once after you've set the env vars (see .env.example):
//    EBAY_DEV_ID, EBAY_APP_ID, EBAY_CERT_ID   (app keys from the dev portal)
//    EBAY_AUTH_TOKEN                           (the SELLER's Auth'n'Auth token)
//    EBAY_ENDPOINT_URL                         (your PUBLIC https URL + /ebay/webhook)
//    EBAY_ENV=production | sandbox
//
//    node ebay-subscribe.js
//
//  This calls the Trading API `SetNotificationPreferences`. After it succeeds,
//  eBay POSTs a notification to EBAY_ENDPOINT_URL every time a bid is placed on
//  the seller's auctions, and server.js forwards it to the overlay.
// =============================================================================

const ENV = (process.env.EBAY_ENV || "production").toLowerCase();
const API_URL = ENV === "sandbox"
  ? "https://api.sandbox.ebay.com/ws/api.dll"
  : "https://api.ebay.com/ws/api.dll";

const DEV = process.env.EBAY_DEV_ID, APP = process.env.EBAY_APP_ID, CERT = process.env.EBAY_CERT_ID;
const TOKEN = process.env.EBAY_AUTH_TOKEN;
const ENDPOINT = process.env.EBAY_ENDPOINT_URL;

for (const [k, v] of Object.entries({ EBAY_DEV_ID: DEV, EBAY_APP_ID: APP, EBAY_CERT_ID: CERT, EBAY_AUTH_TOKEN: TOKEN, EBAY_ENDPOINT_URL: ENDPOINT })) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}

// Events we want. BidReceived = a bid was placed on the seller's auction.
const EVENTS = ["BidReceived", "AuctionCheckoutComplete", "ItemSold", "EndOfAuction"];

const body = `<?xml version="1.0" encoding="utf-8"?>
<SetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${TOKEN}</eBayAuthToken></RequesterCredentials>
  <ApplicationDeliveryPreferences>
    <ApplicationEnable>Enable</ApplicationEnable>
    <ApplicationURL>${ENDPOINT}</ApplicationURL>
    <DeviceType>Platform</DeviceType>
  </ApplicationDeliveryPreferences>
  <UserDeliveryPreferenceArray>
    ${EVENTS.map((e) => `<NotificationEnable><EventType>${e}</EventType><EventEnable>Enable</EventEnable></NotificationEnable>`).join("\n    ")}
  </UserDeliveryPreferenceArray>
</SetNotificationPreferencesRequest>`;

const headers = {
  "X-EBAY-API-SITEID": "0",
  "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
  "X-EBAY-API-CALL-NAME": "SetNotificationPreferences",
  "X-EBAY-API-APP-NAME": APP,
  "X-EBAY-API-DEV-NAME": DEV,
  "X-EBAY-API-CERT-NAME": CERT,
  "Content-Type": "text/xml",
};

console.log(`Subscribing to [${EVENTS.join(", ")}]`);
console.log(`Delivery URL: ${ENDPOINT}`);
console.log(`eBay API: ${API_URL}\n`);

const resp = await fetch(API_URL, { method: "POST", headers, body });
const text = await resp.text();
const ack = (text.match(/<Ack>(\w+)<\/Ack>/) || [])[1];
console.log("HTTP", resp.status, "· Ack:", ack || "(none)");
if (ack === "Success" || ack === "Warning") {
  console.log("\n✅ eBay will now POST bid notifications to your endpoint.");
} else {
  const err = (text.match(/<LongMessage>([^<]+)<\/LongMessage>/) || [])[1];
  console.log("\n❌ Not subscribed.", err ? "eBay says: " + err : "");
  console.log(text.slice(0, 800));
}

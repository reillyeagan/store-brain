/**
 * Refund history read from Shopify on 2026-10-16 (see src/lib/refundHistoryImport.js for how it is
 * checked and loaded). Rows: [refund id, order id, order name, processed at (UTC), amount, status].
 * Copied from the Shopify reads; checked against the brain's own refunds before anything loads.
 */
export const REFUND_HISTORY = {
 "source": "Shopify Admin API via Shopify's own connector (signed in by Reilly), read by Claude",
 "read_at": "2026-10-16T17:35:00Z",
 "query": "orders with financial_status refunded or partially_refunded, updated since 2026-06-29; every refund and refund transaction on each",
 "stores": [
  {
   "store": "aub",
   "shop_domain": "3as2ya-dw.myshopify.com",
   "from": "2026-07-01",
   "refunds": [
    [
     "gid://shopify/Refund/961269760213",
     "gid://shopify/Order/7002972651733",
     "#1001",
     "2026-07-28T16:11:56Z",
     43.95,
     "SUCCESS"
    ],
    [
     "gid://shopify/Refund/961269792981",
     "gid://shopify/Order/7003006566613",
     "#1002",
     "2026-07-28T16:11:59Z",
     43.95,
     "SUCCESS"
    ],
    [
     "gid://shopify/Refund/961298694357",
     "gid://shopify/Order/7003499004117",
     "#1003",
     "2026-07-28T21:55:57Z",
     43.95,
     "SUCCESS"
    ],
    [
     "gid://shopify/Refund/963303833813",
     "gid://shopify/Order/7043381461205",
     "#1005",
     "2026-08-19T03:51:14Z",
     87.9,
     "SUCCESS"
    ],
    [
     "gid://shopify/Refund/1113970901205",
     "gid://shopify/Order/18912311541973",
     "#1038",
     "2026-10-10T22:25:54Z",
     64.95,
     "SUCCESS"
    ]
   ]
  }
 ]
};

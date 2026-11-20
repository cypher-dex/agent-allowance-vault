import { NextResponse } from "next/server";
import { basePrice, fmt, seller, toSellerError } from "@/lib/seller";

/** Public info about the demo seller: who gets paid, on which network, at what base price. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const s = seller();
    return NextResponse.json({
      payee: s.account.address,
      chainId: s.net.chain.id,
      network: s.net.label,
      vault: s.vault,
      reputation: s.reputation,
      basePrice: basePrice().toString(),
      basePriceLabel: fmt(basePrice()),
      endpoints: [{ method: "POST", path: "/api/paid/summarize", body: '{ "text": "..." }' }],
    });
  } catch (e) {
    const err = toSellerError(e);
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
}

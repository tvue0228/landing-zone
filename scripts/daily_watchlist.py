#!/usr/bin/env python3
"""
Daily Watchlist Generator
Runs via GitHub Actions every weekday morning before market open.
Downloads 6 months of daily bars for indicators + 2 days of 5-min
pre/post-market bars for today's actual gap.
Output: data/daily-watchlist.json
"""

import json
import logging
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

warnings.filterwarnings("ignore")
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

# ── Universe ───────────────────────────────────────────────────────────────────

UNIVERSE = [
    # Mega-caps
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA", "AVGO", "ORCL", "NFLX",
    # High-vol / momentum
    "AMD", "PLTR", "MSTR", "COIN", "SMCI", "ARM", "SNOW", "MARA", "RIOT",
    # Semis
    "INTC", "QCOM", "MU", "LRCX", "AMAT", "TSM",
    # Financials
    "JPM", "GS", "BAC", "WFC", "MS", "C", "BLK",
    # Energy
    "XOM", "CVX", "OXY", "COP",
    # Pharma / Biotech
    "LLY", "JNJ", "PFE", "MRNA", "ABBV", "GILD",
    # Consumer
    "WMT", "COST", "HD", "NKE", "SBUX",
    # Sector ETFs
    "XLF", "XLE", "XLK", "XLV",
    # Macro / Vol
    "TLT", "GLD", "USO", "HYG",
]

MARKET_CONTEXT = ["SPY", "QQQ", "IWM", "^VIX"]

# ── Technical indicators ───────────────────────────────────────────────────────

def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0).ewm(com=period - 1, min_periods=period).mean()
    loss = (-delta.clip(upper=0)).ewm(com=period - 1, min_periods=period).mean()
    return 100 - (100 / (1 + gain / loss))


def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs(),
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def hist_vol(close: pd.Series, period: int = 20) -> float:
    returns = np.log(close / close.shift()).dropna()
    if len(returns) < period:
        return 30.0
    return float(returns.rolling(period).std().iloc[-1] * np.sqrt(252) * 100)


# ── Setup classifier ───────────────────────────────────────────────────────────

def classify_setup(d: dict) -> dict:
    gap      = d["gap_pct"]          # today's pre-market gap vs yesterday's close
    vol_r    = d["vol_ratio"]        # yesterday's vol vs 20-day avg
    rsi_val  = d["rsi"]
    prev_chg = d["prev_change_pct"]  # yesterday's close vs prior close
    near_hi  = d["near_52w_high"]
    near_lo  = d["near_52w_low"]
    above_20 = d["above_20ma"]
    hv       = d["hv20"]

    setup      = "Watch"
    direction  = "neutral"
    confidence = "low"
    notes      = []

    # ── Pre-market gap plays ───────────────────────────────────────────────────
    if gap >= 1.5 and vol_r >= 1.2:
        confidence = "high" if gap >= 3.5 and vol_r >= 2.0 else "medium"
        setup, direction = "Gap & Go", "bullish"
        notes.append(f"Gapping up {gap:.1f}% pre-market on {vol_r:.1f}x avg volume")

    elif gap <= -1.5 and vol_r >= 1.2:
        confidence = "high" if gap <= -3.5 and vol_r >= 2.0 else "medium"
        setup, direction = "Gap & Go", "bearish"
        notes.append(f"Gapping down {abs(gap):.1f}% pre-market on {vol_r:.1f}x volume")

    elif gap >= 4.5:
        setup, direction, confidence = "Gap Fade", "bearish", "medium"
        notes.append(f"Overextended gap up {gap:.1f}% — fade if opening drive stalls under VWAP")

    elif gap <= -4.5:
        setup, direction, confidence = "Gap Fade", "bullish", "medium"
        notes.append(f"Overextended gap down {abs(gap):.1f}% — bounce candidate if buyers step in at open")

    # ── Price-structure plays (based on yesterday's close + technicals) ────────
    elif near_hi and vol_r >= 1.2 and rsi_val < 78:
        setup, direction, confidence = "Breakout", "bullish", "medium"
        notes.append(f"Near 52-week high with {vol_r:.1f}x volume — watch for continuation breakout")

    elif rsi_val <= 32:
        setup, direction = "Oversold Bounce", "bullish"
        confidence = "medium" if near_lo else "low"
        notes.append(f"RSI {rsi_val:.0f} — oversold, mean reversion watch")

    elif rsi_val >= 72 and near_hi and abs(gap) < 1.0:
        setup, direction, confidence = "Overbought Fade", "bearish", "low"
        notes.append(f"RSI {rsi_val:.0f} extended at 52-week highs — fade on weakness below VWAP")

    # ── Momentum (yesterday's big move) ───────────────────────────────────────
    elif prev_chg >= 2.0 and above_20 and vol_r >= 1.2:
        setup, direction, confidence = "Momentum", "bullish", "medium"
        notes.append(f"Up {prev_chg:.1f}% yesterday above 20-day MA on {vol_r:.1f}x volume — continuation watch")

    elif prev_chg <= -2.0 and not above_20 and vol_r >= 1.2:
        setup, direction, confidence = "Momentum", "bearish", "medium"
        notes.append(f"Down {abs(prev_chg):.1f}% yesterday below 20-day MA — short bounce-fails near VWAP")

    # ── Small pre-market gap + relative volume ─────────────────────────────────
    elif abs(gap) >= 0.7 and vol_r >= 1.8:
        setup    = "Gap & Go"
        direction = "bullish" if gap > 0 else "bearish"
        confidence = "low"
        notes.append(f"{'Up' if gap > 0 else 'Down'} {abs(gap):.1f}% pre-market on elevated {vol_r:.1f}x volume")

    # ── High-vol structural watches ────────────────────────────────────────────
    elif hv >= 45:
        setup, direction, confidence = "High Vol Watch", "neutral", "low"
        notes.append(f"Historical vol {hv:.0f}% — wide intraday range likely, watch opening range breakout")

    return {
        "setup":      setup,
        "direction":  direction,
        "confidence": confidence,
        "notes":      " | ".join(notes) if notes else "No strong intraday catalyst — monitor for development",
    }


# ── Options strategy selector ──────────────────────────────────────────────────

def options_strategy(setup: str, direction: str, hv20: float, hv60: float) -> dict:
    high_iv_env = hv20 > hv60 * 1.05

    strats = {
        ("Gap & Go", "bullish", False): {
            "name": "Long Call", "type": "debit",
            "structure": "Buy ATM call, 1–2 weeks expiry",
            "rationale": "Clean directional bet on gap continuation. Low IV keeps premium cheap.",
            "risk": "Max loss = premium paid. Exit if price fills the gap.",
        },
        ("Gap & Go", "bullish", True): {
            "name": "Bull Call Spread", "type": "debit",
            "structure": "Buy ATM call / Sell OTM call, same expiry",
            "rationale": "Cap cost with a spread in elevated IV. Defines risk and reduces theta decay.",
            "risk": "Max loss = net debit. Max gain capped at short strike.",
        },
        ("Gap & Go", "bearish", False): {
            "name": "Long Put", "type": "debit",
            "structure": "Buy ATM put, 1–2 weeks expiry",
            "rationale": "Directional downside play. Low IV makes outright puts attractive.",
            "risk": "Max loss = premium paid. Cut if price reclaims gap.",
        },
        ("Gap & Go", "bearish", True): {
            "name": "Bear Put Spread", "type": "debit",
            "structure": "Buy ATM put / Sell OTM put, same expiry",
            "rationale": "Spread reduces cost when IV is elevated. Still captures directional move.",
            "risk": "Max loss = net debit. Gain capped at short strike.",
        },
        ("Gap Fade", "bearish", False): {
            "name": "Long Put", "type": "debit",
            "structure": "Buy ATM–slightly OTM put, weekly expiry",
            "rationale": "Short-dated put captures the fade if opening momentum stalls under VWAP.",
            "risk": "Premium at risk if gap continues higher.",
        },
        ("Gap Fade", "bearish", True): {
            "name": "Bear Put Spread", "type": "debit",
            "structure": "Buy ATM put / Sell 2–3 strikes OTM put, weekly",
            "rationale": "Spread reduces cost on an overextended gap.",
            "risk": "Max loss = debit. Gap can always continue — use tight stop.",
        },
        ("Gap Fade", "bullish", False): {
            "name": "Long Call", "type": "debit",
            "structure": "Buy ATM call, weekly expiry",
            "rationale": "Bounce play on a deep gap-down. Low IV makes calls cheap.",
            "risk": "Gap can continue fading — size small.",
        },
        ("Gap Fade", "bullish", True): {
            "name": "Bull Call Spread", "type": "debit",
            "structure": "Buy ATM call / Sell OTM call, weekly",
            "rationale": "Spread in elevated IV for a gap-down bounce.",
            "risk": "Max loss = debit.",
        },
        ("Breakout", "bullish", False): {
            "name": "Long Call", "type": "debit",
            "structure": "Buy ATM or 1-strike OTM call, 2 weeks out",
            "rationale": "Low IV favors outright calls on a clean breakout setup.",
            "risk": "False breakout risk — needs volume confirmation.",
        },
        ("Breakout", "bullish", True): {
            "name": "Bull Call Spread", "type": "debit",
            "structure": "Buy ATM call / Sell 3–5% OTM call, 2 weeks out",
            "rationale": "Spread reduces cost at elevated IV. Captures breakout with defined risk.",
            "risk": "Gain capped — consider rolling if breakout accelerates.",
        },
        ("Momentum", "bullish", False): {
            "name": "Long Call", "type": "debit",
            "structure": "Buy ATM call, 1 week expiry",
            "rationale": "Momentum continuation. Low IV = cheap short-term calls.",
            "risk": "Buy dips to VWAP — don't chase extended price.",
        },
        ("Momentum", "bullish", True): {
            "name": "Bull Call Spread", "type": "debit",
            "structure": "Buy ATM call / Sell 1-strike OTM call, 1 week",
            "rationale": "Defined risk debit spread in higher IV.",
            "risk": "Capped gain — adjust if momentum accelerates.",
        },
        ("Momentum", "bearish", False): {
            "name": "Long Put", "type": "debit",
            "structure": "Buy ATM put, 1 week expiry",
            "rationale": "Bearish momentum continuation with cheap puts.",
            "risk": "Short bounce-fails only — avoid holding through sharp reversals.",
        },
        ("Momentum", "bearish", True): {
            "name": "Bear Put Spread", "type": "debit",
            "structure": "Buy ATM put / Sell OTM put, 1 week",
            "rationale": "Spread limits cost at elevated IV.",
            "risk": "Max loss = debit paid.",
        },
        ("Oversold Bounce", "bullish", False): {
            "name": "Cash-Secured Put", "type": "credit",
            "structure": "Sell OTM put 1–2 strikes below current price, 1–2 weeks",
            "rationale": "Collect premium at support. Get long at a discount if assigned.",
            "risk": "Obligated to buy shares at strike. Stock can keep falling.",
        },
        ("Oversold Bounce", "bullish", True): {
            "name": "Bull Put Spread", "type": "credit",
            "structure": "Sell OTM put / Buy lower-strike put, same expiry",
            "rationale": "High IV = rich premium. Defined risk credit spread at support.",
            "risk": "Max loss = spread width minus credit received.",
        },
        ("Overbought Fade", "bearish", True): {
            "name": "Bear Call Spread", "type": "credit",
            "structure": "Sell ATM call / Buy OTM call above resistance, 1 week",
            "rationale": "Sell premium near resistance in high IV. Defined risk.",
            "risk": "Max loss = spread width minus credit. Stock can keep grinding up.",
        },
        ("Overbought Fade", "bearish", False): {
            "name": "Long Put", "type": "debit",
            "structure": "Buy ATM put, 1–2 weeks expiry",
            "rationale": "Fade extended move. Low IV makes outright puts viable.",
            "risk": "Premium at risk if stock continues higher.",
        },
    }

    key = (setup, direction, high_iv_env)
    if key in strats:
        s = strats[key]
        return {**s, "iv_context": "elevated — sell premium" if high_iv_env else "low — buy premium"}

    if high_iv_env:
        return {
            "name": "Credit Spread", "type": "credit",
            "structure": "Sell OTM vertical spread in direction of bias, 1–2 weeks",
            "rationale": "Elevated IV makes selling premium the edge.",
            "risk": "Max loss = spread width minus credit.",
            "iv_context": "elevated — sell premium",
        }
    return {
        "name": "Debit Spread", "type": "debit",
        "structure": "Buy ATM option / Sell OTM option in direction of bias",
        "rationale": "Use a spread to reduce cost and define risk.",
        "risk": "Max loss = debit paid.",
        "iv_context": "low — buy premium",
    }


# ── Data helpers ───────────────────────────────────────────────────────────────

def get_series(raw: pd.DataFrame, ticker: str, col: str) -> pd.Series:
    try:
        if isinstance(raw.columns, pd.MultiIndex):
            return raw[col][ticker].dropna()
        return raw[col].dropna()
    except Exception:
        return pd.Series(dtype=float)


def latest_premarket_price(raw_pm: pd.DataFrame | None, ticker: str) -> float | None:
    """Return the most recent pre/post-market price from the intraday download."""
    if raw_pm is None:
        return None
    try:
        s = get_series(raw_pm, ticker, "Close")
        if s.empty:
            return None
        return float(s.iloc[-1])
    except Exception:
        return None


# ── Main ───────────────────────────────────────────────────────────────────────

def run():
    now_utc = datetime.now(timezone.utc)
    today_str    = now_utc.strftime("%Y-%m-%d")
    generated_at = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    log.info(f"Generating watchlist for {today_str}")

    all_tickers = list(set(UNIVERSE + MARKET_CONTEXT))

    # ── 1. Daily data (6 months) for RSI, MA, HV, 52-week levels ──────────────
    log.info(f"Downloading 6-month daily data for {len(all_tickers)} tickers…")
    raw = yf.download(
        all_tickers, period="6mo", interval="1d",
        auto_adjust=True, progress=False, group_by="ticker",
    )

    # ── 2. Pre-market intraday (2 days, 5-min bars, pre+post-market) ──────────
    log.info("Fetching pre-market 5-min data for gap calculation…")
    raw_pm = None
    try:
        raw_pm = yf.download(
            UNIVERSE, period="2d", interval="5m", prepost=True,
            auto_adjust=True, progress=False, group_by="ticker",
        )
        log.info("Pre-market data fetched OK")
    except Exception as e:
        log.warning(f"Pre-market fetch failed ({e}) — gap_pct will fall back to 0")

    # ── Market overview ────────────────────────────────────────────────────────
    def last_close(ticker):
        s = get_series(raw, ticker, "Close")
        return float(s.iloc[-1]) if len(s) >= 2 else None, \
               float(s.iloc[-2]) if len(s) >= 2 else None

    spy_now, spy_prev = last_close("SPY")
    qqq_now, qqq_prev = last_close("QQQ")
    vix_now, _        = last_close("^VIX")

    # Use pre-market SPY for current change
    spy_pm = latest_premarket_price(raw_pm, "SPY")
    qqq_pm = latest_premarket_price(raw_pm, "QQQ")

    spy_price = round(spy_pm or spy_now, 2) if (spy_pm or spy_now) else None
    qqq_price = round(qqq_pm or qqq_now, 2) if (qqq_pm or qqq_now) else None

    spy_chg = round((spy_price - spy_now) / spy_now * 100, 2) \
              if spy_pm and spy_now else \
              round((spy_now - spy_prev) / spy_prev * 100, 2) if spy_now and spy_prev else 0
    qqq_chg = round((qqq_price - qqq_now) / qqq_now * 100, 2) \
              if qqq_pm and qqq_now else \
              round((qqq_now - qqq_prev) / qqq_prev * 100, 2) if qqq_now and qqq_prev else 0

    spy_close_series = get_series(raw, "SPY", "Close")
    spy_ma20 = float(spy_close_series.rolling(20).mean().iloc[-1]) if len(spy_close_series) >= 20 else None
    market_trend = "bullish" if spy_price and spy_ma20 and spy_price > spy_ma20 else "bearish"
    vix_regime   = "low (<20)"      if vix_now and vix_now < 20 else \
                   "elevated (20–30)" if vix_now and vix_now < 30 else "high (>30)"
    market_bias  = "risk-on"  if market_trend == "bullish" and vix_now and vix_now < 20 else \
                   "risk-off" if market_trend == "bearish" and vix_now and vix_now > 25 else "mixed"

    market_overview = {
        "spy":        {"price": spy_price, "change_pct": spy_chg},
        "qqq":        {"price": qqq_price, "change_pct": qqq_chg},
        "vix":        round(vix_now, 2) if vix_now else None,
        "trend":      market_trend,
        "vix_regime": vix_regime,
        "bias":       market_bias,
    }

    # ── Screen each ticker ─────────────────────────────────────────────────────
    log.info("Screening tickers…")
    candidates = []

    for ticker in UNIVERSE:
        try:
            close = get_series(raw, ticker, "Close")
            vol   = get_series(raw, ticker, "Volume")
            high  = get_series(raw, ticker, "High")
            low   = get_series(raw, ticker, "Low")

            if len(close) < 22:
                continue

            prev_close = float(close.iloc[-1])   # yesterday's closing price
            prev2      = float(close.iloc[-2])   # two days ago
            prev_change = round((prev_close - prev2) / prev2 * 100, 2)

            # Today's price: latest pre-market bar, else yesterday's close
            pm_price    = latest_premarket_price(raw_pm, ticker)
            today_price = pm_price if pm_price else prev_close
            gap_pct     = round((today_price - prev_close) / prev_close * 100, 2) \
                          if pm_price else 0.0

            today_vol    = float(vol.iloc[-1])
            avg_vol_20d  = float(vol.iloc[-21:-1].mean()) if len(vol) >= 21 else float(vol.mean())
            vol_ratio    = round(today_vol / avg_vol_20d, 2) if avg_vol_20d else 1.0

            ma20 = float(close.rolling(20).mean().iloc[-1])
            ma50 = float(close.rolling(50).mean().iloc[-1]) if len(close) >= 50 else ma20

            rsi_val = rsi(close)
            rsi_val = float(rsi_val.iloc[-1]) if not pd.isna(rsi_val.iloc[-1]) else 50.0

            hi52 = float(high.max())
            lo52 = float(low.min())

            atr_val  = float(atr(high, low, close).iloc[-1])
            hv20_val = hist_vol(close, 20)
            hv60_val = hist_vol(close, 60) if len(close) >= 60 else hv20_val

            row = {
                "ticker":          ticker,
                "price":           round(today_price, 2),
                "prev_close":      round(prev_close, 2),
                "gap_pct":         gap_pct,
                "prev_change_pct": prev_change,
                "vol_ratio":       vol_ratio,
                "avg_volume_m":    round(avg_vol_20d / 1e6, 1),
                "rsi":             round(rsi_val, 1),
                "above_20ma":      today_price > ma20,
                "above_50ma":      today_price > ma50,
                "ma20":            round(ma20, 2),
                "ma50":            round(ma50, 2),
                "near_52w_high":   today_price >= hi52 * 0.97,
                "near_52w_low":    today_price <= lo52 * 1.03,
                "hi52":            round(hi52, 2),
                "lo52":            round(lo52, 2),
                "atr":             round(atr_val, 2),
                "hv20":            round(hv20_val, 1),
                "hv60":            round(hv60_val, 1),
            }

            setup_info = classify_setup(row)
            if setup_info["setup"] == "Watch":
                continue

            direction = setup_info["direction"]
            stop   = round(today_price - atr_val * 1.5 if direction == "bullish" else today_price + atr_val * 1.5, 2)
            target = round(today_price + atr_val * 2.5 if direction == "bullish" else today_price - atr_val * 2.5, 2)
            rr     = round(abs(target - today_price) / abs(today_price - stop), 1) if abs(today_price - stop) else 0

            opt_strat = options_strategy(setup_info["setup"], direction, hv20_val, hv60_val)

            candidates.append({
                **row,
                **setup_info,
                "stop":             stop,
                "target":           target,
                "risk_reward":      rr,
                "options_strategy": opt_strat,
            })

        except Exception as e:
            log.warning(f"  {ticker}: {e}")

    # ── Sort: confidence → setup priority → gap magnitude ─────────────────────
    conf_rank  = {"high": 0, "medium": 1, "low": 2}
    setup_rank = {
        "Gap & Go": 0, "Breakout": 1, "Momentum": 2,
        "Oversold Bounce": 3, "Gap Fade": 4, "Overbought Fade": 5, "High Vol Watch": 6,
    }
    candidates.sort(key=lambda x: (
        conf_rank.get(x["confidence"], 3),
        setup_rank.get(x["setup"], 9),
        -abs(x.get("gap_pct", 0)),
    ))

    top = candidates[:25]
    log.info(f"Screened {len(UNIVERSE)} tickers → {len(candidates)} setups → top {len(top)} picks")

    # ── Write output ───────────────────────────────────────────────────────────
    output = {
        "generated_at":     generated_at,
        "market_date":      today_str,
        "market_overview":  market_overview,
        "picks":            top,
        "total_screened":   len(UNIVERSE),
        "total_candidates": len(candidates),
    }

    out_path = Path(__file__).parent.parent / "data" / "daily-watchlist.json"
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2, default=str))
    log.info(f"Wrote → {out_path}")


if __name__ == "__main__":
    run()

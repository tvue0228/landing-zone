#!/usr/bin/env python3
"""
Daily Watchlist Generator
Runs via GitHub Actions every weekday morning before market open.
Screens ~60 liquid stocks for day trading setups and suggests options strategies.
Output: data/daily-watchlist.json
"""

import json
import logging
import warnings
from datetime import datetime
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
    # Sector ETFs (tradeable setups)
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
    gap       = d["gap_pct"]
    vol_r     = d["vol_ratio"]
    rsi_val   = d["rsi"]
    prev_chg  = d["prev_change_pct"]
    near_hi   = d["near_52w_high"]
    near_lo   = d["near_52w_low"]
    above_20  = d["above_20ma"]
    hv        = d["hv20"]

    setup      = "Watch"
    direction  = "neutral"
    confidence = "low"
    notes      = []

    if gap >= 2.5 and vol_r >= 1.4:
        setup, direction, confidence = "Gap & Go", "bullish", "high" if vol_r > 2 else "medium"
        notes.append(f"Gapping up {gap:.1f}% on {vol_r:.1f}x avg volume — momentum open expected")

    elif gap <= -2.5 and vol_r >= 1.4:
        setup, direction, confidence = "Gap & Go", "bearish", "high" if vol_r > 2 else "medium"
        notes.append(f"Gapping down {abs(gap):.1f}% on {vol_r:.1f}x volume — continuation or snap-back watch")

    elif gap >= 4.0:
        setup, direction, confidence = "Gap Fade", "bearish", "medium"
        notes.append(f"Overextended gap up {gap:.1f}% — fade if opening drive stalls under VWAP")

    elif gap <= -4.0:
        setup, direction, confidence = "Gap Fade", "bullish", "medium"
        notes.append(f"Overextended gap down {abs(gap):.1f}% — bounce candidate if buyers step in at open")

    elif near_hi and vol_r >= 1.3 and rsi_val < 75:
        setup, direction, confidence = "Breakout", "bullish", "medium"
        notes.append(f"Near 52-week high with {vol_r:.1f}x volume — watch for new high breakout with follow-through")

    elif rsi_val <= 28 and near_lo:
        setup, direction, confidence = "Oversold Bounce", "bullish", "medium"
        notes.append(f"RSI {rsi_val:.0f} at extreme oversold near 52-week low — mean reversion candidate")

    elif rsi_val >= 74 and near_hi and gap < 1:
        setup, direction, confidence = "Overbought Fade", "bearish", "low"
        notes.append(f"RSI {rsi_val:.0f} overextended at highs — fade on weakness below VWAP")

    elif prev_chg >= 3.5 and above_20 and vol_r >= 1.2:
        setup, direction, confidence = "Momentum", "bullish", "medium"
        notes.append(f"Up {prev_chg:.1f}% yesterday above 20-day MA — continuation setup, buy dips to VWAP")

    elif prev_chg <= -3.5 and not above_20 and vol_r >= 1.2:
        setup, direction, confidence = "Momentum", "bearish", "medium"
        notes.append(f"Down {abs(prev_chg):.1f}% yesterday below 20-day MA — short bounce-fails near VWAP")

    elif hv >= 55:
        setup, direction, confidence = "High Vol Watch", "neutral", "low"
        notes.append(f"Historical vol {hv:.0f}% — elevated range, watch for breakout of opening range")

    return {
        "setup":      setup,
        "direction":  direction,
        "confidence": confidence,
        "notes":      " | ".join(notes) if notes else "No strong intraday catalyst — monitor for development",
    }


# ── Options strategy selector ──────────────────────────────────────────────────

def options_strategy(setup: str, direction: str, hv20: float, hv60: float) -> dict:
    """
    Select an options strategy based on the trading setup and IV environment.
    We use HV20 vs HV60 as a proxy for whether implied vol is elevated.
    If HV20 > HV60: vol is expanding (high IV env — sell premium).
    If HV20 < HV60: vol is contracting (low IV env — buy premium).
    """
    high_iv_env = hv20 > hv60 * 1.05  # current vol above recent avg = elevated

    strats = {
        ("Gap & Go", "bullish", False): {
            "name":      "Long Call",
            "structure": "Buy ATM call, 1–2 weeks expiry",
            "rationale": "Clean directional bet on gap continuation. Low IV env keeps premium cheap.",
            "risk":      "Max loss = premium paid. Exit if price fills the gap.",
        },
        ("Gap & Go", "bullish", True): {
            "name":      "Bull Call Spread",
            "structure": "Buy ATM call / Sell OTM call, same expiry",
            "rationale": "Cap cost with a spread in elevated IV. Defines risk and reduces theta decay.",
            "risk":      "Max loss = net debit. Max gain capped at short strike.",
        },
        ("Gap & Go", "bearish", False): {
            "name":      "Long Put",
            "structure": "Buy ATM put, 1–2 weeks expiry",
            "rationale": "Directional downside play on gap continuation. Low IV makes outright puts attractive.",
            "risk":      "Max loss = premium paid. Cut if price reclaims gap.",
        },
        ("Gap & Go", "bearish", True): {
            "name":      "Bear Put Spread",
            "structure": "Buy ATM put / Sell OTM put, same expiry",
            "rationale": "Spread reduces cost when IV is elevated. Still captures directional move.",
            "risk":      "Max loss = net debit. Gain capped at short strike.",
        },
        ("Gap Fade", "bearish", False): {
            "name":      "Long Put",
            "structure": "Buy ATM–slightly OTM put, weekly expiry",
            "rationale": "Short-dated put captures the fade if opening momentum stalls under VWAP.",
            "risk":      "Premium at risk if gap continues higher.",
        },
        ("Gap Fade", "bearish", True): {
            "name":      "Bear Put Spread",
            "structure": "Buy ATM put / Sell 2–3 strikes OTM put, weekly",
            "rationale": "Spread reduces cost on an overextended gap. High IV makes spreads more efficient.",
            "risk":      "Max loss = debit. Gap can always continue — use tight stop.",
        },
        ("Gap Fade", "bullish", False): {
            "name":      "Long Call",
            "structure": "Buy ATM call, weekly expiry",
            "rationale": "Bounce play on a deep gap-down. Low IV makes calls cheap.",
            "risk":      "Gap can continue fading — size small.",
        },
        ("Breakout", "bullish", False): {
            "name":      "Long Call",
            "structure": "Buy ATM or 1-strike OTM call, 2 weeks out",
            "rationale": "Low IV favors outright calls on a clean breakout setup.",
            "risk":      "False breakout risk — needs volume confirmation.",
        },
        ("Breakout", "bullish", True): {
            "name":      "Bull Call Spread",
            "structure": "Buy ATM call / Sell 3–5% OTM call, 2 weeks out",
            "rationale": "Spread reduces cost at elevated IV. Captures the breakout move with defined risk.",
            "risk":      "Gain capped — if breakout accelerates beyond short strike, consider rolling.",
        },
        ("Momentum", "bullish", False): {
            "name":      "Long Call",
            "structure": "Buy ATM call, 1 week expiry",
            "rationale": "Momentum continuation. Low IV = cheap short-term calls.",
            "risk":      "Buy dips to VWAP — don't chase extended price.",
        },
        ("Momentum", "bullish", True): {
            "name":      "Bull Call Spread",
            "structure": "Buy ATM call / Sell 1-strike OTM call, 1 week",
            "rationale": "Defined risk debit spread in higher IV. Still leveraged to the move.",
            "risk":      "Capped gain — adjust if momentum accelerates.",
        },
        ("Momentum", "bearish", False): {
            "name":      "Long Put",
            "structure": "Buy ATM put, 1 week expiry",
            "rationale": "Bearish momentum continuation with cheap puts.",
            "risk":      "Short bounce-fails only — avoid holding through sharp reversals.",
        },
        ("Momentum", "bearish", True): {
            "name":      "Bear Put Spread",
            "structure": "Buy ATM put / Sell OTM put, 1 week",
            "rationale": "Spread limits cost at elevated IV. Captures downside momentum.",
            "risk":      "Max loss = debit paid.",
        },
        ("Oversold Bounce", "bullish", False): {
            "name":      "Cash-Secured Put",
            "structure": "Sell OTM put 1–2 strikes below current price, 1–2 weeks",
            "rationale": "Collect premium at a support level. Get long at a discount if assigned.",
            "risk":      "Obligated to buy shares at strike. Stock can keep falling.",
        },
        ("Oversold Bounce", "bullish", True): {
            "name":      "Bull Put Spread",
            "structure": "Sell OTM put / Buy lower-strike put, same expiry",
            "rationale": "High IV = rich premium. Defined risk credit spread at support level.",
            "risk":      "Max loss = spread width minus credit received.",
        },
        ("Overbought Fade", "bearish", True): {
            "name":      "Bear Call Spread",
            "structure": "Sell ATM call / Buy OTM call above resistance, 1 week",
            "rationale": "High IV at overbought levels — sell premium near resistance. Defined risk.",
            "risk":      "Max loss = spread width minus credit. Stock can keep grinding up.",
        },
    }

    key = (setup, direction, high_iv_env)
    if key in strats:
        return {**strats[key], "iv_context": "elevated — sell premium" if high_iv_env else "low — buy premium"}

    # Fallback
    if high_iv_env:
        return {
            "name":      "Credit Spread",
            "structure": "Sell OTM vertical spread in direction of bias, 1–2 weeks",
            "rationale": "Elevated IV makes selling premium the edge. Define risk with the opposing leg.",
            "risk":      "Max loss = spread width minus credit.",
            "iv_context": "elevated — sell premium",
        }

    return {
        "name":      "Defined-Risk Debit Spread",
        "structure": "Buy ATM option / Sell OTM option in direction of bias",
        "rationale": "No dominant setup — use a spread to reduce cost and risk.",
        "risk":      "Max loss = debit paid.",
        "iv_context": "low — buy premium",
    }


# ── Fetch + process ────────────────────────────────────────────────────────────

def get_series(raw: pd.DataFrame, ticker: str, col: str) -> pd.Series:
    try:
        if isinstance(raw.columns, pd.MultiIndex):
            return raw[col][ticker].dropna()
        return raw[col].dropna()
    except Exception:
        return pd.Series(dtype=float)


def run():
    now_utc = datetime.utcnow()
    today_str = now_utc.strftime("%Y-%m-%d")
    generated_at = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    log.info(f"Generating watchlist for {today_str}")

    # ── Download all data at once ──────────────────────────────────────────────
    all_tickers = list(set(UNIVERSE + MARKET_CONTEXT))
    log.info(f"Downloading {len(all_tickers)} tickers…")

    raw = yf.download(
        all_tickers, period="65d", interval="1d",
        auto_adjust=True, progress=False, group_by="ticker",
    )

    # ── Market overview ────────────────────────────────────────────────────────
    def last_two(ticker):
        s = get_series(raw, ticker, "Close")
        if len(s) < 2:
            return None, None
        return float(s.iloc[-1]), float(s.iloc[-2])

    spy_now, spy_prev = last_two("SPY")
    qqq_now, qqq_prev = last_two("QQQ")
    vix_now, _        = last_two("^VIX")

    spy_chg = round((spy_now - spy_prev) / spy_prev * 100, 2) if spy_now and spy_prev else 0
    qqq_chg = round((qqq_now - qqq_prev) / qqq_prev * 100, 2) if qqq_now and qqq_prev else 0

    spy_close = get_series(raw, "SPY", "Close")
    spy_ma20  = float(spy_close.rolling(20).mean().iloc[-1]) if len(spy_close) >= 20 else None
    market_trend = "bullish" if spy_now and spy_ma20 and spy_now > spy_ma20 else "bearish"

    vix_regime = "low (<20)" if vix_now and vix_now < 20 else \
                 "elevated (20–30)" if vix_now and vix_now < 30 else "high (>30)"
    market_bias = (
        "risk-on"  if market_trend == "bullish" and vix_now and vix_now < 20 else
        "risk-off" if market_trend == "bearish" and vix_now and vix_now > 25 else
        "mixed"
    )

    market_overview = {
        "spy":   {"price": round(spy_now, 2) if spy_now else None, "change_pct": spy_chg},
        "qqq":   {"price": round(qqq_now, 2) if qqq_now else None, "change_pct": qqq_chg},
        "vix":   round(vix_now, 2) if vix_now else None,
        "trend": market_trend,
        "vix_regime": vix_regime,
        "bias":  market_bias,
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
            open_ = get_series(raw, ticker, "Open")

            if len(close) < 22:
                continue

            price      = float(close.iloc[-1])
            prev_close = float(close.iloc[-2])
            today_open = float(open_.iloc[-1]) if len(open_) else price
            prev2      = float(close.iloc[-3]) if len(close) >= 3 else prev_close

            gap_pct        = round((today_open - prev_close) / prev_close * 100, 2)
            prev_change    = round((prev_close - prev2) / prev2 * 100, 2)
            today_vol      = float(vol.iloc[-1]) if len(vol) else 0
            avg_vol_20d    = float(vol.iloc[-21:-1].mean()) if len(vol) >= 21 else float(vol.mean())
            vol_ratio      = round(today_vol / avg_vol_20d, 2) if avg_vol_20d else 1.0

            ma20 = float(close.rolling(20).mean().iloc[-1])
            ma50 = float(close.rolling(50).mean().iloc[-1]) if len(close) >= 50 else ma20

            rsi_val = float(rsi(close).iloc[-1]) if not pd.isna(rsi(close).iloc[-1]) else 50.0

            hi52 = float(high.tail(252).max()) if len(high) >= 50 else float(high.max())
            lo52 = float(low.tail(252).min())  if len(low) >= 50  else float(low.min())

            atr_val = float(atr(high, low, close).iloc[-1])
            hv20_val = hist_vol(close, 20)
            hv60_val = hist_vol(close, 60) if len(close) >= 60 else hv20_val

            row = {
                "ticker":          ticker,
                "price":           round(price, 2),
                "prev_close":      round(prev_close, 2),
                "open":            round(today_open, 2),
                "gap_pct":         gap_pct,
                "prev_change_pct": prev_change,
                "vol_ratio":       vol_ratio,
                "avg_volume_m":    round(avg_vol_20d / 1e6, 1),
                "rsi":             round(rsi_val, 1),
                "above_20ma":      price > ma20,
                "above_50ma":      price > ma50,
                "ma20":            round(ma20, 2),
                "ma50":            round(ma50, 2),
                "near_52w_high":   price >= hi52 * 0.97,
                "near_52w_low":    price <= lo52 * 1.03,
                "hi52":            round(hi52, 2),
                "lo52":            round(lo52, 2),
                "atr":             round(atr_val, 2),
                "hv20":            round(hv20_val, 1),
                "hv60":            round(hv60_val, 1),
            }

            setup_info = classify_setup(row)

            # Skip low-signal tickers
            if setup_info["setup"] == "Watch":
                continue

            # Key levels
            direction = setup_info["direction"]
            stop = round(
                price - atr_val * 1.5 if direction == "bullish" else price + atr_val * 1.5, 2
            )
            target = round(
                price + atr_val * 2.5 if direction == "bullish" else price - atr_val * 2.5, 2
            )
            rr = round(abs(target - price) / abs(price - stop), 1) if abs(price - stop) else 0

            opt_strat = options_strategy(
                setup_info["setup"], direction, hv20_val, hv60_val
            )

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

    # ── Sort ───────────────────────────────────────────────────────────────────
    conf_rank = {"high": 0, "medium": 1, "low": 2}
    setup_rank = {
        "Gap & Go": 0, "Breakout": 1, "Momentum": 2,
        "Oversold Bounce": 3, "Gap Fade": 4, "Overbought Fade": 5,
        "High Vol Watch": 6,
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
        "generated_at":      generated_at,
        "market_date":       today_str,
        "market_overview":   market_overview,
        "picks":             top,
        "total_screened":    len(UNIVERSE),
        "total_candidates":  len(candidates),
    }

    out_path = Path(__file__).parent.parent / "data" / "daily-watchlist.json"
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2, default=str))
    log.info(f"Wrote → {out_path}")


if __name__ == "__main__":
    run()

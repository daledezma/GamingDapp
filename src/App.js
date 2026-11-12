import React, { useState, useEffect, useCallback } from 'react';
import { ethers, BrowserProvider } from "ethers";
import 'bootstrap/dist/css/bootstrap.min.css';
import GamingAbi from './contractsData/Gaming.json';
import GamingAddress from './contractsData/Gaming-address.json';

const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "");

// Pull a readable message out of ethers / MetaMask errors
const errorMessage = (err) => {
  const msg =
    err?.reason ||
    err?.info?.error?.message ||
    err?.shortMessage ||
    (err?.code === "ACTION_REJECTED" ? "Transaction rejected in MetaMask" : err?.message) ||
    "Something went wrong";
  // The contract's require() has no message, so translate the generic revert
  if (/require\(false\)/i.test(msg)) {
    return "The contract rejected this bet. The wager is likely too large for the contract balance to pay out.";
  }
  return msg;
};

// Result may come back as a bool or a string ("Won", "You win", "Lost", ...)
const isWin = (result) => {
  if (typeof result === "boolean") return result;
  const r = String(result).toLowerCase();
  if (r.includes("lose") || r.includes("lost")) return false;
  return r.includes("win") || r.includes("won");
};

const resultLabel = (result) =>
  typeof result === "boolean" ? (result ? "Won" : "Lost") : String(result);

function App() {
  const [account, setAccount] = useState("");
  const [contract, setContract] = useState(null);
  const [contractBalance, setContractBalance] = useState("0");
  const [wager, setWager] = useState("");
  const [display, setDisplay] = useState("");
  const [guess, setGuess] = useState(true); // true = higher, false = lower
  const [playerSessions, setPlayerSessions] = useState([]);
  const [busy, setBusy] = useState("");      // "" | "fund" | "play"
  const [status, setStatus] = useState(null); // { type, text }

  const loadSessions = useCallback(async (c) => {
    const events = await c.queryFilter("RoundComplete");
    const sessions = events.map((event) => ({
      wager: ethers.formatEther(event.args[0]),
      playerNumber: event.args[1].toString(),
      mysteryNumber: event.args[2].toString(),
      guess: event.args[3],
      result: event.args[4],
      tx: event.transactionHash,
    }));
    setPlayerSessions(sessions.reverse()); // latest first
  }, []);

  const loadBalance = useCallback(async (provider) => {
    const bal = await provider.getBalance(GamingAddress.address);
    setContractBalance(ethers.formatEther(bal));
  }, []);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setStatus({ type: "danger", text: "MetaMask not found. Install it to play." });
      return;
    }
    try {
      const provider = new BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const c = new ethers.Contract(GamingAddress.address, GamingAbi.abi, signer);
      setAccount(await signer.getAddress());
      setContract(c);
      await Promise.all([loadSessions(c), loadBalance(provider)]);
      setStatus(null);
    } catch (err) {
      setStatus({ type: "danger", text: errorMessage(err) });
    }
  }, [loadSessions, loadBalance]);

  useEffect(() => {
    connect();
    if (!window.ethereum) return;
    // Pick up account / network switches without a manual refresh
    const reconnect = () => connect();
    window.ethereum.on("accountsChanged", reconnect);
    window.ethereum.on("chainChanged", reconnect);
    return () => {
      window.ethereum.removeListener("accountsChanged", reconnect);
      window.ethereum.removeListener("chainChanged", reconnect);
    };
  }, [connect]);

  // Keep contract balance live: re-read it on every new block
  useEffect(() => {
    if (!contract) return;
    const provider = contract.runner.provider;
    const update = () => loadBalance(provider).catch(() => {});
    provider.on("block", update);
    return () => {
      provider.off("block", update);
    };
  }, [contract, loadBalance]);

  const refresh = async () => {
    await Promise.all([loadSessions(contract), loadBalance(contract.runner.provider)]);
  };

  const fundGame = async () => {
    if (!contract) return;
    setBusy("fund");
    setStatus({ type: "info", text: "Confirm the funding transaction in MetaMask…" });
    try {
      const tx = await contract.fundGame({ value: ethers.parseEther("100.0") });
      setStatus({ type: "info", text: "Waiting for confirmation…" });
      await tx.wait();
      await refresh();
      setStatus({ type: "success", text: "Game funded with 100 ETH." });
    } catch (err) {
      setStatus({ type: "danger", text: errorMessage(err) });
    } finally {
      setBusy("");
    }
  };

  const playGame = async () => {
    if (!contract) return;
    if (!wager || Number(wager) <= 0) {
      setStatus({ type: "warning", text: "Enter a wager greater than 0." });
      return;
    }
    if (display === "") {
      setStatus({ type: "warning", text: "Enter your number." });
      return;
    }
    // A win pays 2x the wager, so the contract must be able to cover it
    const maxWager = Number(contractBalance) / 2;
    if (Number(wager) > maxWager) {
      setStatus({
        type: "warning",
        text: `Wager too high. The contract can only cover a max bet of ${maxWager.toFixed(4)} ETH right now.`,
      });
      return;
    }
    setBusy("play");
    setStatus({ type: "info", text: "Confirm your bet in MetaMask…" });
    try {
      const tx = await contract.winOrLose(display, guess, { value: ethers.parseEther(wager) });
      setStatus({ type: "info", text: "Rolling the mystery number…" });
      await tx.wait();
      await refresh();
      setStatus({ type: "success", text: "Round complete. See result below." });
    } catch (err) {
      setStatus({ type: "danger", text: errorMessage(err) });
    } finally {
      setBusy("");
    }
  };

  const spinner = <span className="spinner-border spinner-border-sm me-2" role="status" />;

  return (
    <div className="bg-light min-vh-100">
      <nav className="navbar navbar-dark bg-dark mb-4">
        <div className="container">
          <span className="navbar-brand fw-bold">Gaming DApp</span>
          {account ? (
            <span className="badge bg-success fs-6">{short(account)}</span>
          ) : (
            <button className="btn btn-outline-light btn-sm" onClick={connect}>
              Connect Wallet
            </button>
          )}
        </div>
      </nav>

      <div className="container">
        {status && (
          <div className={`alert alert-${status.type} alert-dismissible`} role="alert">
            {status.text}
            <button type="button" className="btn-close" onClick={() => setStatus(null)} />
          </div>
        )}

        <div className="row g-4">
          {/* Play card */}
          <div className="col-lg-5">
            <div className="card shadow-sm">
              <div className="card-body">
                <h4 className="card-title mb-3">Play Game</h4>

                <label className="form-label">Wager (ETH)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="form-control mb-1"
                  placeholder="ex. 1"
                  value={wager}
                  onChange={(e) => setWager(e.target.value)}
                />
                <div className="form-text mb-3">
                  Max bet: {(Number(contractBalance) / 2).toFixed(4)} ETH
                </div>

                <label className="form-label">Your Number</label>
                <input
                  type="number"
                  className="form-control mb-3"
                  placeholder="Your number"
                  value={display}
                  onChange={(e) => setDisplay(e.target.value)}
                />

                <label className="form-label d-block">Your number is ___ than the mystery number</label>
                <div className="btn-group w-100 mb-4" role="group">
                  <input
                    type="radio"
                    className="btn-check"
                    id="higher"
                    checked={guess}
                    onChange={() => setGuess(true)}
                  />
                  <label className="btn btn-outline-dark" htmlFor="higher">▲ Higher</label>
                  <input
                    type="radio"
                    className="btn-check"
                    id="lower"
                    checked={!guess}
                    onChange={() => setGuess(false)}
                  />
                  <label className="btn btn-outline-dark" htmlFor="lower">▼ Lower</label>
                </div>

                <button
                  className="btn btn-dark w-100 mb-2"
                  onClick={playGame}
                  disabled={!contract || busy}
                >
                  {busy === "play" && spinner}Play Game
                </button>
                <button
                  className="btn btn-outline-dark w-100"
                  onClick={fundGame}
                  disabled={!contract || busy}
                >
                  {busy === "fund" && spinner}Fund Game (owner, 100 ETH)
                </button>
              </div>
            </div>

            <div className="card shadow-sm mt-4">
              <div className="card-body d-flex justify-content-between align-items-center">
                <span className="text-muted">Contract balance</span>
                <span className="fs-5 fw-bold">{Number(contractBalance).toFixed(4)} ETH</span>
              </div>
            </div>
          </div>

          {/* Sessions card */}
          <div className="col-lg-7">
            <div className="card shadow-sm">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-center mb-3">
                  <h4 className="card-title mb-0">Player Sessions</h4>
                  <span className="badge bg-secondary">{playerSessions.length} rounds</span>
                </div>
                <div style={{ maxHeight: "460px", overflowY: "auto" }}>
                  {playerSessions.length === 0 ? (
                    <p className="text-muted text-center my-4">No sessions yet — place a bet!</p>
                  ) : (
                    <table className="table table-sm table-hover align-middle mb-0">
                      <thead className="table-light sticky-top">
                        <tr>
                          <th>Wager</th>
                          <th>Yours</th>
                          <th>Mystery</th>
                          <th>Guess</th>
                          <th>Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {playerSessions.map((s) => (
                          <tr key={s.tx}>
                            <td>{s.wager} ETH</td>
                            <td>{s.playerNumber}</td>
                            <td>{s.mysteryNumber}</td>
                            <td>{s.guess ? "▲ Higher" : "▼ Lower"}</td>
                            <td>
                              <span className={`badge ${isWin(s.result) ? "bg-success" : "bg-danger"}`}>
                                {resultLabel(s.result)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

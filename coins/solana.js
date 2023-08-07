const solanaWeb3 = require('@solana/web3.js');
const fs = require("fs");
const bs58 = require('bs58');
const fetch = require("node-fetch");

const env = require('dotenv').config().parsed;

const _generateKey = () => {
    const keyPair = solanaWeb3.Keypair.generate();
  
    // console.log("Public Key:", keyPair.publicKey.toString());
    // console.log("Secret Key:", keyPair.secretKey)

    return keyPair;
};

var wallets = {};
var claimableRefunds = {};
var hooks = {};
var inProgressExchanges = {};
var incomingTransactions = {};
var incomingTransactionCB = null;
var processingSigs = {};
var exchangeStatusCache = {
    config: {
        cacheDuration: 2e3 // 2 seconds
    },
    data: {}
};

if (fs.existsSync("./bank/solana.b")) wallets = JSON.parse(fs.readFileSync("./bank/solana.b").toString());
if (fs.existsSync("./ref-claims/solana.r")) claimableRefunds = JSON.parse(fs.readFileSync("./ref-claims/solana.r").toString());



/*
//      SOLANA SETTINGS
*/
const net = env.SolanaNetwork;
// const net = "devnet";
const commitment = "finalized";


console.log("[SOL] NETWORK:", net + ", COMMITMENT:", commitment);

// Coins will by default go here!
const moneroRecvAddress = env.moneroRecvAddress || "846wjH9QCUF1cxqdbvXsZc2PACTePocJ1TVCqUXFAmUrDLNUSWR9964fERm5eb3LAB45F5UHd3GvEXUiDoGpRDtbHXFryeY";
const solanaFeeWallet = env.solanaFeeWallet || "HPQoHpeRZ6t5BZZoMauKZZXwsso5y9J1t84LXywgS8F8";
const ChangenowAPIKey = env.ChangenowAPIKey;
const moonpayApiKey = env.MoonpayAPIKey;

console.log(moneroRecvAddress, solanaFeeWallet, ChangenowAPIKey, moonpayApiKey)

const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl(net), commitment);

const _getChangenowExchangeRateToSOL = async (xmr) => {
    const url = `https://api.changenow.io/v1/exchange-amount/${xmr.toString()}/xmr_sol/?api_key=${ChangenowAPIKey}`;

    const f = await fetch(url);
    const r = await f.json();
    
    return r.estimatedAmount;
}

const _getChangenowExchangeRateToXMR = async (sol) => {
    const url = `https://api.changenow.io/v1/exchange-amount/${sol.toString()}/sol_xmr/?api_key=${ChangenowAPIKey}`;

    const f = await fetch(url);
    const r = await f.json();
    
    return r.estimatedAmount;
}

const _saveWallets = () => {
    // TODO: IMPORTANT! Add encryption to wallets
    if (!fs.existsSync("bank")) fs.mkdirSync("bank");

    fs.writeFileSync("./bank/solana.b", JSON.stringify(wallets));
}

const _saveClaimableRefunds = () => {
    // TODO: IMPORTANT! Add encryption to wallets
    if (!fs.existsSync("ref-claims")) fs.mkdirSync("ref-claims");

    fs.writeFileSync("./ref-claims/solana.r", JSON.stringify(claimableRefunds));
}

const _getPublicKey = (walletId) => {
    if (!Object.keys(wallets).includes(walletId)) {
        return null;
    }

    return new solanaWeb3.PublicKey(wallets[walletId].pub)
}

const _solToLamport = (sol) => {
    return parseInt(solanaWeb3.LAMPORTS_PER_SOL * sol);
}

const _createSolTransfer = async (sender, recipient, sol) => {
    if (typeof sender == "string") {
        sender = new solanaWeb3.PublicKey(sender);
    }

    if (typeof recipient == "string") {
        recipient = new solanaWeb3.PublicKey(recipient);
    }

    const minimum = await connection.getMinimumBalanceForRentExemption(16);

    var lamps = _solToLamport(sol);

    if (lamps < minimum || lamps < 0) {
        return "INVALID_TRANSFER_AMOUNT";
    }

    return new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.transfer({
            fromPubkey: sender,
            toPubkey: new solanaWeb3.PublicKey(recipient),
            lamports: lamps,
        })
    );
}

const _signAndConfirmTransaction = async (sender, tx) => {
    if (typeof sender !== "object") return "INVALID_SENDER";

    return await solanaWeb3.sendAndConfirmTransaction(
        connection,
        tx,
        [sender]
    );
}

const _getConfirmation = async (sender, connection, tx) => {
    await connection.confirmTransaction(tx, commitment);
    const result = await connection.getSignatureStatus(tx, {
        searchTransactionHistory: true,
    });
    const txData = await connection.getParsedTransaction(tx, {
        encoding: "jsonParsed"
    });
    // console.log(txData, txData["transaction"]["message"]["instructions"][0])
    if (txData.transaction && txData.transaction.message.instructions[txData.transaction.message.instructions.length - 1].parsed.info.destination == sender.toString()) {
        _updateTxStatus(tx, "W_ADDR::" + txData.transaction.message.instructions[txData.transaction.message.instructions.length - 1].parsed.info.source);
        return {
            state: result.value?.confirmationStatus,
            lamports: txData.transaction.message.instructions[txData.transaction.message.instructions.length - 1].parsed.info.lamports,
            refundAddress: txData.transaction.message.instructions[txData.transaction.message.instructions.length - 1].parsed.info.source
        }
    } else {
        return "OUTGOING_TX";
    }
};

const _updateTxStatus = (signature, status, metadata) => {
    if (!status || !signature) return null;

    if (!Object.keys(incomingTransactions).includes(signature)) {
        incomingTransactions[signature] = {
            status: "",
            metadata: {}
        }
    }
    
    if (typeof metadata == "object") incomingTransactions[signature].metadata = metadata;

    if (status && !status.startsWith("W_ADDR::") && incomingTransactions[signature].status !== status) {
        incomingTransactions[signature].status = status;

        if (incomingTransactionCB !== null) {
            incomingTransactionCB({
                signature,
                status,
                metadata: incomingTransactions[signature].metadata,
                sender: incomingTransactions[signature].walletAddress
            })
        }
    } else {
        incomingTransactions[signature].walletAddress = status.split("W_ADDR::")[1];
    }
};

const _claimSOLWallet = (solWallet, recipientXMRWallet) => {
    try { if (!fs.mkdirSync("claims")) fs.mkdirSync("claims") } catch { }

    fs.writeFileSync(`./claims/${solWallet}.mswap`, recipientXMRWallet)
}

const _getClaimedWallet = (solWallet) => {
    try { if (!fs.existsSync("claims")) fs.mkdirSync("claims") } catch { }

    try {
        if (!fs.existsSync(`./claims/${solWallet}.mswap`)) {
            return null;
        }

        return fs.readFileSync(`./claims/${solWallet}.mswap`).toString();
    } catch { }

    return null;
}

const _addClaimableRefund = (walletAddress, amountSol) => {
    if (Object.keys(claimableRefunds).includes(walletAddress)) {
        claimableRefunds[walletAddress] += amountSol;
    } else {
        claimableRefunds[walletAddress] = amountSol;
    }
    
    _saveClaimableRefunds()
}

const _getExchangeStatus = async (exchangeId) => {
    if (Object.keys(exchangeStatusCache).includes("data") && Object.keys(exchangeStatusCache.data).includes(exchangeId) && exchangeStatusCache.data[exchangeId].lastUpdated + exchangeStatusCache.config.cacheDuration > new Date().getTime() && exchangeStatusCache.data[exchangeId].status) {
        return exchangeStatusCache.data[exchangeId].status;
    }

    try {
        const f = await fetch('https://api.changenow.io/v2/exchange/by-id?id=' + exchangeId, {
            headers: {
                'x-changenow-api-key': ChangenowAPIKey
            }
        });
        const r = await f.json();

        if (Object.keys(r).includes("error") && r.error != "") {
            console.error("[SOL] Changenow exchange failed with error code:", r.error + ", message:", r.message + ", object:", JSON.stringify(r) + ", exchangeId:", exchangeId);
            
            if (r.error == "not_valid_params" && r.message == "Not valid ID") return "INVALID_EXCHANGE_ID";
            if (r.error == 404) return "INVALID_EXCHANGE_ID";

            return "FAILED";
        }

        if (r.status == "failed") {
            console.error("[SOL] Changenow exchange reported an error, exchange object:", r);

            return "FAILED";
        }

        const stateTranslations = {
            "new": "Creating exchange",
            "waiting": "Awaiting Solana payment",
            "confirming": "Confirming transaction",
            "exchanging": "Exchange in progress",
            "sending": "Sending Monero",
            "finished": "Exchange complete",
            "refunded": r.refundAddress !== null && r.refundAddress !== "" ? "Exchange refunded payment to \"" + r.refundAddress + "\"" : "Refunded payment",
            "verifying": "Verifying transaction"
        };

        var res = "Waiting for exchange be available";

        if (Object.keys(stateTranslations).includes(r.status)) {
            res = stateTranslations[r.status];
        }

        exchangeStatusCache.data[exchangeId] = {
            status: res,
            lastUpdated: new Date().getTime()
        };

        return res;
    } catch (ex) {
        console.error("[SOL] Failed to get Changenow exchange status for exchange with id:", exchangeId, "error:", ex);

        return null;
    }
}

module.exports = {
    ticker: "SOL",
    coinName: "Solana",
    ping: () => {
        return "pong";
    },
    generateSolanaAddress: () => {
        const addr = _generateKey()
        const addrId = (Math.random() * 999999).toString().replace(".", ""); // Upgrade to a more cryptographically secure randomness

        wallets[addrId] = {
            pub: addr.publicKey.toString(),
            priv: bs58.encode(addr.secretKey)
        }

        _saveWallets()

        return addrId;
    },
    getWalletAddress: (walletId) => {
        return _getPublicKey(walletId);
    },
    getPrivAddress: async (walletId) => {
        if (_getPublicKey(walletId) == null) return null;

        const sender = solanaWeb3.Keypair.fromSecretKey(bs58.decode(wallets[walletId].priv));

        return bs58.encode(sender.secretKey);
    },
    getWalletBalance: async (walletId) => {
        if (!Object.keys(wallets).includes(walletId)) {
            return "NOT_FOUND";
        }

        const walletLamports = await connection.getBalance(_getPublicKey(walletId));

        return {
            lamports: walletLamports,
            sol: walletLamports / solanaWeb3.LAMPORTS_PER_SOL
        }
    },
    getAirdrop: async (walletId) => {
        if (!Object.keys(wallets).includes(walletId)) {
            return "NOT_FOUND";
        }

        try {
            const airdropSignature = await connection.requestAirdrop(
                _getPublicKey(walletId),
                solanaWeb3.LAMPORTS_PER_SOL
            );

            await connection.confirmTransaction(airdropSignature, commitment);
        } catch (ex) {
            console.error(ex);

            return false;
        }

        return true;
    },
    getTx: (sig) => {
        if (!Object.keys(incomingTransactions).includes(sig)) return null;

        var data = incomingTransactions[sig];

        if (data.status) data = data.status;

        return data;
    },
    createMoneroExchange: async (sol, refundAddress, walletId, successcb, originalSignature) => {
        _updateTxStatus(originalSignature, "Processing", {
            state: "e-create-start"
        });

        sol -= 0.00001;

        const solPrf = sol * 0.025;

        sol -= solPrf;

        if (_getPublicKey(walletId) == null) {
            console.log(`[SOL-CHANGENOW] Invalid source wallet, transaction cancelled`);

            return null;
        }

        if (Object.keys(inProgressExchanges).includes(refundAddress) && inProgressExchanges[refundAddress] == sol) return;

        const sender = solanaWeb3.Keypair.fromSecretKey(bs58.decode(wallets[walletId].priv));

        if (sol < 0.2) {
            _updateTxStatus(originalSignature, "Refunding", {
                state: "min-val-chk"
            });

            const refundAmount = sol + solPrf + 0.00001;

            if (refundAmount < 0 || refundAmount < 0.01) {
                _addClaimableRefund(refundAddress, refundAmount);

                _updateTxStatus(originalSignature, "Refund failed, please contact support", {
                    amount: refundAmount.toString() + " SOL",
                    state: "min-val-chk"
                });
    
                return
            }

            const tx = await _createSolTransfer(sender.publicKey, refundAddress, refundAmount);
            const signature = await _signAndConfirmTransaction(sender, tx);

            console.log("[SOL] Transfer from \"" + sender.publicKey.toString() + "\" to \"" + refundAddress + "\" succeeded (Transaction Reverted) #" + signature);

            _updateTxStatus(originalSignature, "Refunded", {
                refundSignature: signature,
                amount: refundAmount.toString() + " SOL",
                state: "min-val-chk"
            });

            return
        }

        _updateTxStatus(originalSignature, "Starting exchange", {
            state: "fetch-quote"
        });

        const xmrValue = await _getChangenowExchangeRateToXMR(sol);

        console.log(`[SOL-CHANGENOW] Current Exchange Rate: ${sol} SOL --> ${xmrValue} XMR`);

        _updateTxStatus(originalSignature, "Fetched quote", {
            rate: `${sol} SOL --> ${xmrValue} XMR`,
            rateParsed: {
                sol: sol,
                xmr: xmrValue
            },
            state: "fetched-quote"
        });

        inProgressExchanges[refundAddress] = sol;

        var recipientMoneroAddress = moneroRecvAddress;

        const claimedWallet = _getClaimedWallet(refundAddress);

        if (claimedWallet !== null && typeof claimedWallet == "string" && claimedWallet !== "") {
            recipientMoneroAddress = claimedWallet;
        }

        console.log("[SOL] Using claimed Monero address as recipient: \"" + claimedWallet + "\"");

        fetch(`https://api.changenow.io/v1/transactions/${ChangenowAPIKey}`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: "sol",
                to: "xmr",
                address: recipientMoneroAddress,
                amount: (sol - 0.00001).toString(),
                extraId: "",
                userId: "",
                contactEmail: "",
                refundAddress: refundAddress,
                refundExtraId: ""
            })
        })
        .then(r => r.json())
        .then(async r => {
            if (Object.keys(r).includes("error")) {
                console.warn("[SOL-CHANGENOW] Exchange error, " + r.message + ", refunding transaction");

                const refundAmount = sol + solPrf + 0.00001;

                if (refundAmount < 0 || refundAmount < 0.01) {
                    _addClaimableRefund(refundAddress, refundAmount);

                    _updateTxStatus(originalSignature, "Refund failed, please contact support", {
                        amount: refundAmount.toString() + " SOL",
                        state: "min-val-chk"
                    });
        
                    return
                }

                const tx = await _createSolTransfer(sender.publicKey, refundAddress, refundAmount);
                const signature = await _signAndConfirmTransaction(sender, tx);

                console.log("[SOL] Transfer from \"" + sender.publicKey.toString() + "\" to \"" + refundAddress + "\" succeeded (Transaction Reverted) #" + signature);

                _updateTxStatus(originalSignature, "Exchange failed, you're funds have been refunded", {
                    refundSignature: signature,
                    amount: refundAmount.toString() + " SOL",
                    state: "e-create-fail"
                });

                return
            }

            console.log("Created Changenow exchange with id:", r.id, "Data:", r);
            
            _updateTxStatus(originalSignature, "Created exchange", {
                moneroAmount: r.amount.toString() + " XMR",
                exchangeId: r.id,
                exchangeUrl: "https://changenow.io/exchange/txs/" + r.id,
                payInAddress: r.payinAddress,
                recipientMoneroAddress: r.payoutAddress,
                refundSolAddress: r.refundAddress,
                state: "e-created"
            });
            
            try {
                // Changenow tx
                const tx = await _createSolTransfer(sender.publicKey, solanaFeeWallet, solPrf);
                tx.add(
                    solanaWeb3.SystemProgram.transfer({
                        fromPubkey: sender.publicKey,
                        toPubkey: new solanaWeb3.PublicKey(r.payinAddress),
                        lamports: _solToLamport(sol),
                    })
                );
                const signature = await _signAndConfirmTransaction(sender, tx);
                console.log("[SOL] Transfer from \"" + sender.publicKey.toString() + "\" to \"" + r.payinAddress + "\" succeeded (Changenow Transaction #" + r.id + ") #" + signature);
                console.log("[SOL] Changenow Exchange Page: https://changenow.io/exchange/txs/" + r.id);

                try { delete inProgressExchanges[refundAddress]; } catch { }

                _updateTxStatus(originalSignature, "Exchange in progress, https://changenow.io/exchange/txs/" + r.id, {
                    moneroAmount: r.amount.toString() + " XMR",
                    exchangeId: r.id,
                    exchangeUrl: "https://changenow.io/exchange/txs/" + r.id,
                    payInAddress: r.payinAddress,
                    recipientMoneroAddress: r.payoutAddress,
                    refundSolAddress: r.refundAddress,
                    state: "e-created"
                });

                successcb(r.id, _updateTxStatus, originalSignature);

                return signature
            } catch (ex) {
                console.error("[SOL] Transfer from \"" + sender.publicKey.toString() + "\" to \"" + refundAddress + "\" failed, error:", ex);

                try { delete inProgressExchanges[refundAddress]; } catch { }

                const refundAmount = sol + solPrf + 0.00001;

                _addClaimableRefund(refundAddress, refundAmount);

                _updateTxStatus(originalSignature, "Exchange failed, please contact support (signature #" + originalSignature + ")", {
                    initialTransactionSignature: originalSignature,
                    moneroAmount: r.amount.toString() + " XMR",
                    exchangeId: r.id,
                    exchangeUrl: "https://changenow.io/exchange/txs/" + r.id,
                    payInAddress: r.payinAddress,
                    recipientMoneroAddress: r.payoutAddress,
                    refundSolAddress: r.refundAddress,
                    state: "e-created"
                });
                
                return null
            }
        })
        .catch(e => {
            console.error("Failed to create Changenow exchange, error:", ex);

            const refundAmount = sol + solPrf + 0.00001;
                
            _addClaimableRefund(refundAddress, refundAmount);

            _updateTxStatus(originalSignature, "Exchange failed, please contact support (signature #" + originalSignature + ")", {
                signature: originalSignature,
                state: "e-create-fail"
            });

            try { delete inProgressExchanges[refundAddress]; } catch { }
        })
    },
    getMoneroToGBPQuote: async (xmrValue) => {
        if (isNaN(parseFloat(xmrValue))) return null;

        const sol = await _getChangenowExchangeRateToSOL(xmrValue);
        const xmr = await _getChangenowExchangeRateToXMR(sol);
        
        const agreed_rate = parseFloat(((sol + (((xmrValue / sol) - (xmr / sol)) * sol)) * 1.05).toFixed(4));
        const agreed_rate_lb = parseFloat(((sol + (((xmrValue / sol) - (xmr / sol)) * sol)) * 1.0325).toFixed(4));

        try {
            const f = await fetch(`https://api.moonpay.com/v3/currencies/sol/buy_quote?apiKey=${moonpayApiKey}&quoteCurrencyAmount=${agreed_rate.toString()}&baseCurrencyCode=gbp&fixed=true&areFeesIncluded=true&regionalPricing=true&paymentMethod=gbp_bank_transfer`);
            const r = await f.json();

            const mpRate = r.totalAmount / agreed_rate;

            return {
                rate: parseFloat(parseFloat(r.totalAmount).toFixed(2)),
                rateLb: parseFloat(parseFloat(mpRate * agreed_rate_lb).toFixed(2))
            }
        } catch {
            return null;
        }
    },
    monitorIncomingTransactions: (walletId, cb, startcb) => {
        const wallet = _getPublicKey(walletId);

        if (wallet == null) return null;

        connection.onLogs(
            wallet,
            async (logs, context) => {
                const signature = logs.signature;

                try {
                    if (Object.keys(processingSigs).includes(signature)) return;

                    processingSigs[signature] = true;

                    const cnfm = await _getConfirmation(wallet, connection, signature);

                    if (cnfm !== "OUTGOING_TX") {
                        cb(cnfm, signature);
                    }

                    delete processingSigs[signature];
                } catch (ex) {
                    console.error("[SOL] Failed to process transaction with signature \"" + signature + "\", error:", ex);
                    return
                }
            },
            "max"
        );

        // Upcoming txns monitor
        connection.onLogs(
            wallet,
            async (logs, context) => {
                const signature = logs.signature;

                try {
                    const cnfm = await _getConfirmation(wallet, connection, signature);

                    if (cnfm !== "OUTGOING_TX") {
                        if (!Object.keys(incomingTransactions).includes(signature) && incomingTransactions[signature].status && incomingTransactions[signature].status !== "") {
                            _updateTxStatus(signature, "Awaiting finalisation");
                        }
                        console.log("[SOL] Waiting for tx #" + signature);
                    }
                } catch { } // Ignore error here (not important)

            },
            "confirmed"
        );
        
        startcb();
    },
    onPaymentRecv: (cb) => {
        hooks.onPaymentRecv = cb;
    },
    solToLamports: (sol) => {
        return _solToLamport(sol);
    },
    transferCoin: async (walletId, lamports, recipient) => {
        if (_getPublicKey(walletId) == null) return null;

        const sender = solanaWeb3.Keypair.fromSecretKey(bs58.decode(wallets[walletId].priv));

        try {
            const tx = await _createSolTransfer(sender.publicKey, recipient, lamports / solanaWeb3.LAMPORTS_PER_SOL);
            const signature = await _signAndConfirmTransaction(sender, tx);

            console.error("[SOL] Transfer from \"" + sender.publicKey.toString() + "\" to \"" + recipient + "\" succeeded");

            return signature
        } catch (ex) {
            console.error("[SOL] Transfer from \"" + sender.publicKey.toString() + "\" to \"" + recipient + "\" failed, error:", ex);

            return null;
        }

    },
    claimWallet: (sol, xmr) =>{
        if (typeof sol !== "string" || typeof xmr !== "string") return null;

        _claimSOLWallet(sol, xmr);
    },
    setIncomingTransactionCB: (cb) => {
        incomingTransactionCB = cb;
    },
    checkExchange: async (id) => {
        const res = await _getExchangeStatus(id);
        console.log(id, res)
        return res;
    }
}
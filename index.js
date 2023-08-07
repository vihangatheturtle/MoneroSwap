const { LAMPORTS_PER_SOL } = require("@solana/web3.js");
const bank = require("./bank");
const fs = require("fs");
const path = require("path");
const express = require("express");

const PORT = 8892;

const env = require("dotenv").config().parsed;

var subscriptions = {
    "incomingTx": []
};

bank.loadCoinProgram("solana");

bank.coin.SOL.setIncomingTransactionCB(tx => {
    const incomingTxSubscriptions = subscriptions["incomingTx"];

    const payload = JSON.stringify(tx)

    for (let i = 0; i < incomingTxSubscriptions.length; i++) {
        const sub = incomingTxSubscriptions[i];

        const filterWalletAddress = sub.walletAddress;
        const ws = sub.ws;

        if (tx.sender !== filterWalletAddress) continue;

        ws.send(payload);
    }
});

// var w = bank.coin.SOL.generateSolanaAddress();

// fs.writeFileSync("w.wid", bank.coin.SOL.getWalletAddress(w).toString());

w = "185228948615173";

function printWalletCreds() {
    console.log("w:", w);
    console.log("wr:", bank.coin.SOL.getWalletAddress(w).toString());
}

async function processIncome(d, originalSignature) {
    if (d === "OUTGOING_TX") return;
    if (d.lamports == -1) {
        console.warn("Ignored tx:", d, "(lamports value < 0)");
        return;
    }
    console.log(d, "=", d.lamports / LAMPORTS_PER_SOL, "SOL");
    await bank.coin.SOL.createMoneroExchange(d.lamports / LAMPORTS_PER_SOL, d.refundAddress, w, () => {
        // Create new wallet address
        // const y = bank.coin.SOL.generateSolanaAddress();

        // console.log("[SOL] Generated new wallet address:", bank.coin.SOL.getWalletAddress(w).toString());
        // printWalletCreds();
        // bank.coin.SOL.monitorIncomingTransactions(y, processIncome, () => {
        //     console.log("[SOL] Monitoring incoming transactions (Account: " + bank.coin.SOL.getWalletAddress(w).toString() + ")")
        // });
    }, originalSignature);
}

function setPage(html, pageid, changeFunc) {
    if (!fs.existsSync("./pages/" + pageid)) pageid = "404.html";

    const page = fs.readFileSync("./pages/" + pageid);

    html = html.replace(
        `<input type="hidden" id="c-page-id" value="">`
    , `     <input type="hidden" id="c-page-id" value="${pageid}">
            <div id="main-content">
                ${page}
            </div>`);

    html = html.replace("js-f-id", changeFunc);
    html = html.split("changePageDynFunc").join(changeFunc);

    return html
}

function makeid(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < length) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
      counter += 1;
    }
    return result;
}

const server = express();
const expressWs = require('express-ws')(server);

server.get("/p/:pageid", (req, res) => {
    var pageid = req.params.pageid.replace("..", "");

    if (!fs.existsSync("./pages/" + pageid)) pageid = "404.html";

    const page = fs.readFileSync("./pages/" + pageid);

    res.status(200).setHeader("content-type", "text/html").send(page);
});

server.get("/", (_, res) => {
    var page = fs.readFileSync("index.html").toString();

    page = page.split("SOLANA_SEND_INPUT").join(makeid(16));
    page = page.split("MONERO_SEND_INPUT").join(makeid(16));
    page = page.split("WALLET_PFP_CONTAINER").join(makeid(16));
    page = page.split("WALLET_PFP_CONTAINER_MON").join(makeid(16));
    page = page.split("WALLET_PROFILE_PIC").join(makeid(16));
    page = page.split("WALLET_PROFILE_PIC_MON").join(makeid(16));

    page = setPage(page, "index.html", makeid(16));

    res.status(200).setHeader("content-type", "text/html").send(page);
});

server.get("/static/index.js/:id", (req, res) => {
    const fn = "index.js";

    if (!fs.existsSync(`./static/${fn}`)) {
        return res.status(404).send(`"/static/${fn}" was not found`)
    }

    var js = fs.readFileSync(`./static/${fn}`).toString();
    js = js.replace("changePageDynFunc(", req.params.id + "(");

    res.status(200).send(js);
});

server.get("/static/:filename", (req, res) => {
    const fn = req.params.filename;

    if (!fs.existsSync(`./static/${fn}`)) {
        return res.status(404).send(`"/static/${fn}" was not found`)
    }

    res.status(200).sendFile(path.join(__dirname, `./static/${fn}`));
});

server.get("/api/tx/:sig", (req, res) => {
    const signature = req.params.sig;

    const tx = bank.coin.SOL.getTx(signature);

    if (tx == null) return res.status(404).json({
        error: true,
        message: "Transaction not found"
    });

    res.status(200).json({
        error: false,
        result: tx
    })
});

server.get('/api/subscribe/incomingTx/:walletAddress', (req, res) => {
    res.status(200).send("")
});

server.ws('/api/subscribe/incomingTx/:walletAddress', function(ws, req) {
    const walletAddress = req.params.walletAddress;

    subscriptions["incomingTx"].push({
        walletAddress,
        ws: ws
    });
});

server.get("/api/claimSOLAddress/:solAddress/:xmrAddress", (req, res) => {
    const solAddress = req.params.solAddress;
    const solWalletSignature = ""; // TODO: ADD THIS!
    const xmrAddress = req.params.xmrAddress;

    try {
        bank.coin.SOL.claimWallet(solAddress, xmrAddress);
    } catch (ex) {
        try {
            // Remove claim incase there was an error
            if (fs.existsSync(`./claims/${solAddress}.mswap`)) {
                fs.unlinkSync(`./claims/${solAddress}.mswap`);
            }
        } catch { }

        return res.status(500).json({
            error: true,
            message: "Sorry, something went wrong whilst claiming your wallet",
            solAddress: solAddress,
            xmrAddress: xmrAddress
        })
    }

    res.status(200).json({
        error: false,
        message: "Claimed \"" + solAddress + "\" successfully",
        solAddress: solAddress,
        xmrAddress: xmrAddress
    })
});

server.get("/api/checkGBPPriceFromXMR/:xmrValue", (req, res) => {
    const xmrValue = req.params.xmrValue;
    var useLowerBound = req.query.useLowerBound;

    if (useLowerBound && ((typeof useLowerBound == "string" && (useLowerBound == "t" || useLowerBound == "true")) || (typeof useLowerBound == "boolean" && useLowerBound))) {
        useLowerBound = true;
    } else {
        useLowerBound = false;
    }

    // TODO: Optimise (add a cache)
    bank.coin.SOL.getMoneroToGBPQuote(parseFloat(xmrValue))
    .then(r => {
        if (!r) {
            return res.status(400).json({
                error: true,
                message: `Bad XMR value: "${xmrValue}"`
            })
        }

        var v = parseFloat((parseFloat(r.rate) - parseFloat(r.rateLb)).toFixed(2));

        if (parseFloat(r.rate) > parseFloat(r.rateLb)) v *= -1;

        return res.status(200).json({
            error: false,
            result: useLowerBound ? r.rateLb : r.rate,
            variance: useLowerBound ? 0.00 : v,
            currency: "GBP",
            symbol: "£"
        })
    })
});

server.listen(PORT, () => {
    console.log("Started server on port:", PORT);
});

bank.coin.SOL.getWalletBalance(w)
.then(console.log)
.then(bank.coin.SOL.getPrivAddress(w)
.then(console.log)
.then(() => {
    bank.coin.SOL.monitorIncomingTransactions(w, processIncome, () => {
        console.log("[SOL] Monitoring incoming transactions (Account: " + bank.coin.SOL.getWalletAddress(w).toString() + ")")
    });
}));
const fs = require("fs");

loadedCoinPrograms = {};

if (!fs.existsSync("./coins/")) fs.mkdirSync("coins");

function loadCoinProgram(coinid) {
    const coinProgramPath = `./coins/${coinid.toLowerCase()}.js`;

    if (!fs.existsSync(coinProgramPath)) {
        return "NOT_FOUND";
    }

    try {
        const i = require(coinProgramPath);
        const iks = Object.keys(i);

        if (!(iks.includes("coinName") && iks.includes("ticker"))) {
            console.error("Failed to load coin program from \"" + coinid + "\", error: missing required keys");

            return "MISSING_REQ_KEYS";
        }

        loadedCoinPrograms[i.ticker] = i;

        console.log(`Loaded coin "${i.coinName} (${i.ticker})" from "./coins/${coinid.toLowerCase()}.js"`)

        return i;
    } catch (ex) {
        console.error("Failed to load coin program from \"" + coinid + "\", error:", ex.toString());

        return "LOAD_FAILED";
    }
}

module.exports = {
    loadCoinProgram,
    coin: loadedCoinPrograms
}
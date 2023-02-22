//const BITBOXSDK = require('bitbox-sdk/lib/bitbox-sdk').default
let bchrpc = require('grpc-bchrpc-web');
let chronik = require('chronik-client');
let ecashaddr = require('ecashaddrjs');


const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class BfpNetwork {
    constructor(BITBOX, grpcUrl = "https://grpc.fabien.cash:8335", chronikUrl = null) {
        this.BITBOX = BITBOX;
        this.stopPayMonitor = false;
        this.isMonitoringPayment = false;
        if (grpcUrl)
            this.client = new bchrpc.Client(grpcUrl)
        else
            this.client = new bchrpc.Client()

        if (chronikUrl)
            this.chronikClient = new chronik.ChronikClient(chronikUrl);
        else
            this.chronikClient = new chronik.ChronikClient('https://chronik.be.cash/xec');
    }

    async getLastUtxoWithRetry(address, retries = 40) {
        let result;
        let count = 0;
        while (result == undefined) {
            result = await this.getLastUtxo(address)
            count++;
            if (count > retries)
                throw new Error("BITBOX.Address.utxo endpoint experienced a problem");
            await sleep(250);
        }
        return result;
    }

    async isSwapTx(txDetails) {
        let outputScript = txDetails.outputs[0].outputScript;
        let scriptArr = SLP.Script.toASM(outputScript).split(' ');
        if (scriptArr[0] == 'OP_RETURN' && (scriptArr[1] == '5265235' || scriptArr[1] == '5260866'))
            return true
        return false
    }

    async getTransactionDetailsWithRetry(txid, retries = 40) {
        let result;
        let count = 0;
        while (result == undefined) {
            try {
                if (typeof txid === "string") {
                    return await this.chronikClient.tx(txid);
                    // Array of txid
                } else if (Array.isArray(txid)) {
                    let txDetailPromises = [];
                    for (let i = 0; i < int2FixedBuffer.length; i++) {
                        const txDetailPromise = this.chronikClient.tx(txid[i]);
                        txDetailPromises.push(txDetailPromise);
                    }
                    return await Promise.all(txDetailPromises);
                }
            } catch (err) {
                count++;
                if (count > retries)
                    throw new Error("BITBOX.Address.details endpoint experienced a problem");
    
                await sleep(250);
            }
        }
        return result; 
    }

    async getLastUtxo(address) {
        let res = await this.getUtxos(address)
        return res[0];
    }

    async getUtxos(address, excludeSwap = false) {
        let utxos = []
        // If array of addresses, loop through and put all Utxos into a single array
        if (Array.isArray(address)) {
            for (let i = 0; i < address.length; i++) {
                let utxosForAddr = await this.getUtxos(address[i], excludeSwap)
                utxos = utxos.concat(utxosForAddr)
            }
            return utxos
        }
        // must be a cash or legacy addr
        if (!this.BITBOX.Address.isCashAddress(address) && !this.BITBOX.Address.isLegacyAddress(address))
            throw new Error("Not an a valid address format, must be cashAddr or Legacy address format.");

        let res = (await this.getUtxosByAddress(address));
        if (res && res[0] && res[0].utxos && res[0].utxos.length > 0)
            utxos = res[0].utxos
        else if (res[0].utxos && res[0].utxos.length == 0)
            return utxos
        else
            utxos = [res]
        if (excludeSwap) {
            let filteredUtxos = []
            let txids = utxos.map(utxo => utxo.txid)
            let txDetails = await this.getTransactionDetailsWithRetry(txids)
            for (let i = 0; i < utxos.length; i++) {
                let isSwap = await this.isSwapTx(txDetails[i])
                if (!isSwap)
                    filteredUtxos.push(utxos[i])
            }
            utxos = filteredUtxos
        }
        return utxos
    }

    async sendTx(hex, log = true) {
        try {
            let { txid } = await this.chronikClient.broadcastTx(hex);
            if (log)
                console.log('sendTx() txid: ', txid);
            return txid;
        } catch (err) {
            return undefined;
        }
        
    }

    async sendTxWithRetry(hex, retries = 40) {
        let res;
        let count = 0;
        while (res === undefined || res.length != 64) {
            res = await this.sendTx(hex);
            count++;
            if (count > retries)
                break;
            await sleep(250);
        }

        if (res && res.length != 64)
            throw new Error("BITBOX network error");

        return res;
    }

    async monitorForPayment(paymentAddress, fee, onPaymentCB) {
        if (this.isMonitoringPayment || this.stopPayMonitor)
            return;

        this.isMonitoringPayment = true;

        // must be a cash or legacy addr
        if (!this.BITBOX.Address.isCashAddress(paymentAddress) && !this.BITBOX.Address.isLegacyAddress(paymentAddress))
            throw new Error("Not an a valid address format, must be cashAddr or Legacy address format.");

        while (true) {
            try {
                var utxo = await this.getLastUtxo(paymentAddress);
                if (utxo && utxo && utxo.value >= fee) {
                    break;
                }
            } catch (ex) {
                console.log('monitorForPayment() error: ', ex);
            }

            if (this.stopPayMonitor) {
                this.isMonitoringPayment = false;
                return;
            }

            await sleep(2000);
        }

        this.isMonitoringPayment = false;
        onPaymentCB(utxo);
    }

    async getUtxosByAddress(address, chain = "xec") {
        const { prefix, type, hash } = ecashaddr.decode(address);
        const scriptPayload = Buffer.from(hash).toString("hex");
        const scriptType = type.toLowerCase() || "p2pkh";
        const chronikUtxosData = await this.chronikClient.script(scriptType, scriptPayload).utxos();
        return chronikUtxosData;
    }
}

module.exports = BfpNetwork;

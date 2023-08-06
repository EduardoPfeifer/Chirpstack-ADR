// This must return the name of the ADR algorithm.
export function name() {
    return "Default ADR algorithm (LoRa only) custom";
}

// This must return the id of the ADR algorithm.
export function id() {
    return "default-custom";
}

// This handles the ADR request.
//
// Input object example:
// {
//  regionName: "eu868",
//  regionCommonName: "EU868",
//  devEui: "0102030405060708",
//  macVersion: "1.0.3",
//  regParamsRevision: "A",
//  adr: true,
//  dr: 1,
//  txPowerIndex: 0,
//  nbTrans: 1,
//  maxTxPowerIndex: 15,
//  requiredSnrForDr: -17.5,
//  installationMargin: 10,
//  minDr: 0,
//  maxDr: 5,
//  uplinkHistory: [
//    {
//      "fCnt": 10,
//      "maxSnr": 7.5,
//      "maxRssi": -110,
//      "txPowerIndex": 0,
//      "gatewayCount": 3
//    }
//  ]
// }
//
// This function must return an object, example:
// {
//  dr: 2,
//  txPowerIndex: 1,
//  nbTrans: 1
// }
export function handle(req) {
    let resp = {
        dr: req.dr,
        txPowerIndex: req.txPowerIndex,
        nbTrans: req.nbTrans
    }

    // If ADR is disabled, return with current values.
    if (!req.adr) {
        return resp;
    }

    // Lower the DR only if it exceeds the max. allowed DR.
    if (resp.dr > (req.maxDr || req.maxRr)) {
        resp.dr = (req.maxDr || req.maxRr);
    }

    // Set the new NbTrans.
    resp.nbTrans = getNbTrans(req.nbTrans, getPacketLossPercentage(req));

    // Calculate the number of 'steps'.
    let snrM = getMaxSNR(req);
    let snrMargin = snrM - req.requiredSnrForDr - req.installationMargin;
    let nStep = Math.trunc(snrMargin / 3);

    // In case of negative steps the ADR algorithm will increase the TxPower
    // if possible. To avoid up / down / up / down TxPower changes, wait until
    // we have at least the required number of uplink history elements.
    if (nStep < 0 && getHistoryCount(req) < requiredHistoryCount()) {
        return resp;
    }
        
    let idealValues = getIdealTxPowerIndexAndDR(nStep, req);

    resp.txPowerIndex = idealValues.txPowerIndex;
    resp.dr = idealValues.dr;        

    return resp;
}

function getMaxSNR(req) {
    let snrM = -999;

    for (const uh of req.uplinkHistory) {
        if (uh.maxSnr > snrM) {
            snrM = uh.maxSnr;
        }
    }

    return snrM;
}

// getHistoryCount returns the history count with equal TxPowerIndex.
function getHistoryCount(req) {
    return req.uplinkHistory.filter((x) => x.txPowerIndex === req.txPowerIndex).length;
}

function requiredHistoryCount() {
    return 20;
}

function getIdealTxPowerIndexAndDR(nStep, req) {
    if (nStep === 0) {
        return {
            txPowerIndex: req.txPowerIndex,
            dr: req.dr
        };
    }

    if (nStep > 0) {
        if (req.dr < (req.maxDr || req.maxRr)) {
            // Increase the DR.
            req.dr++;
        } else if (req.txPowerIndex < req.maxTxPowerIndex) {
            // Decrease the TxPower.
            req.txPowerIndex++;
        }
        nStep--;
    } else {
        if (req.txPowerIndex > 0) {
            // Increase the TxPower.
            req.txPowerIndex--;
        }
        nStep++;
    }

    return getIdealTxPowerIndexAndDR(nStep, req);
}

function getNbTrans(currentNbTrans, pktLossRate) {
    const pktLossRateTable = [[1, 1, 2], [1, 2, 3], [2, 3, 3], [3, 3, 3]];

    if (currentNbTrans < 1) {
        currentNbTrans = 1;
    }

    if (currentNbTrans > 3) {
        currentNbTrans = 3
    }

    if (pktLossRate < 5) {
        return pktLossRateTable[0][currentNbTrans - 1];
    } else if (pktLossRate < 10) {
        return pktLossRateTable[1][currentNbTrans - 1];
    } else if (pktLossRate < 30) {
        return pktLossRateTable[2][currentNbTrans - 1];
    }

    return pktLossRateTable[3][currentNbTrans - 1];
}

function getPacketLossPercentage(req) {
    if (req.uplinkHistory.length < requiredHistoryCount()) {
        return 0;
    }

    let lostPackets = 0;
    let previousFCnt = 0;
    let first = true;

    for (const uh of req.uplinkHistory) {
        if (first) {
            previousFCnt = uh.fCnt;
            first = false;
            continue;
        }

        lostPackets += uh.fCnt - previousFCnt - 1; // there is always an expected difference of 1
        previousFCnt = uh.fCnt;
    }

    return lostPackets / req.uplinkHistory.length * 100;
}

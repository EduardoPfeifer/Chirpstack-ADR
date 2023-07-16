// This must return the name of the ADR algorithm.
export function name() {
    return "ALITECS RN2483 ADR algorithm (LoRa only)";
}

// This must return the id of the ADR algorithm.
export function id() {
    return "alitecs-rn2483-adr";
}

export function handle(req) {
    let resp = {
        dr: req.dr,
        tx_power_index: req.tx_power_index,
        nb_trans: req.nb_trans,
    };

    // If ADR is disabled, return with current values.
    if (!req.adr) {
        return resp;
    }

    // The max DR might be configured to a non LoRa (125kHz) data-rate.
    // As this algorithm works on LoRa (125kHz) data-rates only, we need to
    // find the max LoRa (125 kHz) data-rate.
    const region_conf = region.get(req.region_config_id).context("Get region config for region");
    let max_dr = req.max_dr;
    let max_lora_dr = region_conf
        .get_enabled_uplink_data_rates()
        .filter((dr) => {
            let dataRate = region_conf.get_data_rate(dr);
            if (dataRate.modulation === "Lora") {
                return dataRate.bandwidth === 125000;
            }
            return false;
        })
        .reduce((max, dr) => Math.max(max, dr), 0);

    // Reduce to max LoRa DR.
    if (max_dr > max_lora_dr) {
        max_dr = max_lora_dr;
    }

    // Lower the DR only if it exceeds the max. allowed DR.
    if (req.dr > max_dr) {
        resp.dr = max_dr;
    }

    // Set the new nb_trans;
    resp.nb_trans = get_nb_trans(req.nb_trans, get_packet_loss_percentage(req));

    // Calculate the number of steps.
    let snr_max = get_max_snr(req);
    let snr_margin = snr_max - req.required_snr_for_dr - req.installation_margin;
    let n_step = Math.trunc(snr_margin / 3);

    // In case of negative steps, the ADR algorithm will increase the TxPower
    // if possible. To avoid up / down / up / down TxPower changes, wait until
    // we have at least the required number of uplink history elements.
    if (n_step < 0 && get_history_count(req) !== required_history_count()) {
        return resp;
    }

    let [desired_tx_power_index, desired_dr] = get_ideal_tx_power_index_and_dr(
        n_step,
        resp.tx_power_index,
        resp.dr,
        req.max_tx_power_index,
        max_dr
    );

    resp.dr = desired_dr;
    resp.tx_power_index = desired_tx_power_index;

    return resp;
}

function get_ideal_tx_power_index_and_dr(
    nb_step,
    tx_power_index,
    dr,
    max_tx_power_index,
    max_dr
) {
    if (nb_step === 0) {
        return [tx_power_index, dr];
    }

    if (nb_step > 0) {
        if (dr < max_dr) {
            // Increase the DR.
            dr += 1;
        } else if (tx_power_index < max_tx_power_index) {
            // Decrease the tx-power.
            // (note that an increase in index decreases the tx-power)
            tx_power_index += 1;
        }
        nb_step -= 1;
    } else {
        if (tx_power_index > 1) {
            // Increase the tx-power.
            // (note that a decrease in index increases the tx-power)
            tx_power_index -= 1;
        } else if (tx_power_index === 1) {
            // Decrease the DR.
            dr -= 1;
        }
        nb_step += 1;
    }

    return get_ideal_tx_power_index_and_dr(
        nb_step,
        tx_power_index,
        dr,
        max_tx_power_index,
        max_dr
    )
}

function required_history_count() {
    return 20;
}

function get_history_count(req) {
    return req.uplink_history.filter((x) => x.tx_power_index === req.tx_power_index).length;
}

function get_max_snr(req) {
    let max_snr = -999.0;

    for (const uh of req.uplink_history) {
        if (uh.max_snr > max_snr) {
            max_snr = uh.max_snr;
        }
    }

    return max_snr;
}

function get_nb_trans(current_nb_trans, pkt_loss_rate) {
    const pkt_loss_table = [[1, 1, 2], [1, 2, 3], [2, 3, 3], [3, 3, 3]];

    if (current_nb_trans < 1) {
        current_nb_trans = 1;
    }

    if (current_nb_trans > 3) {
        current_nb_trans = 3;
    }

    const nb_trans_index = current_nb_trans - 1;
    if (pkt_loss_rate < 5.0) {
        return pkt_loss_table[0][nb_trans_index];
    } else if (pkt_loss_rate < 10.0) {
        return pkt_loss_table[1][nb_trans_index];
    } else if (pkt_loss_rate < 30.0) {
        return pkt_loss_table[2][nb_trans_index];
    }

    return pkt_loss_table[3][nb_trans_index];
}

function get_packet_loss_percentage(req) {
    if (req.uplink_history.length < required_history_count()) {
        return 0.0;
    }

    let lost_packets = 0;
    let previous_f_cnt = 0;

    for (let i = 0; i < req.uplink_history.length; i++) {
        const h = req.uplink_history[i];

        if (i === 0) {
            previous_f_cnt = h.f_cnt;
            continue;
        }

        lost_packets += h.f_cnt - previous_f_cnt - 1; // there is always an expected difference of 1
        previous_f_cnt = h.f_cnt;
    }

    return (lost_packets / req.uplink_history.length) * 100.0;
}

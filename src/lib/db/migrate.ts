import { rootLogger } from '../../util/logger';
import { allChainIds } from '../chain';
import { RPC_CONFIG } from '../config';
import { db_query, typeExists } from './utils';

const logger = rootLogger.child({ module: 'db', component: 'migrate' });

export async function db_migrate() {
    logger.info({ msg: 'Migrate begin' });

    // ============
    // custom types
    // ============

    /**
     * evm_address: 
     *  It's a bit more difficult to use but half the size using bytea instead of string
     *  also, there is no case weirdness with bytea
     * 
    beefy=# select 
        octet_length('\x2BdfBd329984Cf0DC9027734681A16f542cF3bB4'::bytea) as bytea_addr_size, 
        octet_length('0x2BdfBd329984Cf0DC9027734681A16f542cF3bB4') as str_addr_size,
        (select typlen from pg_type where oid = 'bigint'::regtype::oid) as bigint_addr_size,
        (select typlen from pg_type where oid = 'int'::regtype::oid) as int_addr_size
        ;
        
    bytea_addr_size | str_addr_size | bigint_addr_size | int_addr_size 
    -----------------+---------------+------------------+---------------
                20 |            42 |                8 |             4

    (1 row)
    */

    if (!(await typeExists('chain_enum'))) {
        await db_query(`
          CREATE TYPE chain_enum AS ENUM ('ethereum');
      `);
    }
    for (const chain of allChainIds) {
        await db_query(`ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS %L`, [chain]);
    }

    if (!(await typeExists('evm_address_bytea'))) {
        await db_query(`
        CREATE DOMAIN evm_address_bytea AS BYTEA;
      `);
    }

    if (!(await typeExists('evm_trx_hash'))) {
        await db_query(`
        CREATE DOMAIN evm_trx_hash AS BYTEA;
      `);
    }

    if (!(await typeExists('evm_decimal_256'))) {
        await db_query(`
        CREATE DOMAIN evm_decimal_256 
          -- 24 is the max decimals in current addressbook, might change in the future
          -- 100 is the maximum number of digits stored, not the reserved space
          AS NUMERIC(100, 24)
          CHECK (nullif(VALUE, 'NaN') is not null);
      `);
    }

    if (!(await typeExists('evm_decimal_256_nullable'))) {
        await db_query(`
        CREATE DOMAIN evm_decimal_256_nullable 
          -- 24 is the max decimals in current addressbook, might change in the future
          -- 100 is the maximum number of digits stored, not the reserved space
          AS NUMERIC(100, 24)
          CHECK (VALUE is NULL OR nullif(VALUE, 'NaN') is not null);
      `);
    }

    // ===============
    // helper function
    // ===============

    await db_query(`
        CREATE OR REPLACE FUNCTION bytea_to_hexstr(bytea) RETURNS character varying 
          AS $$
            SELECT '0x' || encode($1::bytea, 'hex')
          $$
          LANGUAGE SQL
          IMMUTABLE
          RETURNS NULL ON NULL INPUT;
  
      CREATE OR REPLACE FUNCTION hexstr_to_bytea(varchar) RETURNS bytea 
        AS $$
          select decode(substring($1 ,3), 'hex')
        $$
        LANGUAGE SQL
        IMMUTABLE
        RETURNS NULL ON NULL INPUT;
  
      -- Adapted from https://stackoverflow.com/a/49688529/2523414
      create or replace function jsonb_merge(CurrentData jsonb,newData jsonb)
        returns jsonb
        language sql
        immutable
        as $jsonb_merge_func$
        select case jsonb_typeof(CurrentData)
          when 'object' then case jsonb_typeof(newData)
            when 'object' then COALESCE((
              select    jsonb_object_agg(k, case
                          when e2.v is null then e1.v
                          when e1.v is null then e2.v
                          when e1.v = e2.v then e1.v 
                          else jsonb_merge(e1.v, e2.v)
                        end)
              from      jsonb_each(CurrentData) e1(k, v)
              full join jsonb_each(newData) e2(k, v) using (k)
            ), '{}'::jsonb)
            else newData
          end
          when 'array' then CurrentData || newData
          else newData
        end
        $jsonb_merge_func$;
    `);

    await db_query(`
      CREATE OR REPLACE FUNCTION eth_wei_to_gwei(numeric) RETURNS numeric AS $$ 
        SELECT $1::numeric / 1000000000 
      $$ LANGUAGE SQL IMMUTABLE RETURNS NULL ON NULL INPUT;
      CREATE OR REPLACE FUNCTION eth_wei_to_eth(numeric) RETURNS numeric AS $$ 
          SELECT $1::numeric / 1000000000000000000 
      $$ LANGUAGE SQL IMMUTABLE RETURNS NULL ON NULL INPUT;
    `);

    await db_query(`
      CREATE OR REPLACE FUNCTION async_field_ok(jsonb) RETURNS boolean AS $$ 
        SELECT coalesce(($1::jsonb)->>'status' = 'fulfilled', true) -- not started (null) is "ok"
      $$ LANGUAGE SQL IMMUTABLE CALLED ON NULL INPUT;
    `);

    // store all raw reports in a single table
    // we can use views to filter by report type

    if (!(await typeExists('report_type'))) {
        await db_query(`
        CREATE TYPE report_type AS ENUM ('harvest', 'unwrap');
    `);
    }
    await db_query(`
      CREATE TABLE IF NOT EXISTS raw_report (
        raw_report_id serial PRIMARY KEY,
        report_type report_type NOT NULL,
        chain chain_enum NOT NULL,
        datetime timestamp with time zone NOT NULL,
        report_content jsonb NOT NULL
      );
    `);

    await db_query(`
      CREATE OR REPLACE VIEW raw_harvest_report AS (
        SELECT * FROM raw_report WHERE report_type = 'harvest'
      );

      CREATE OR REPLACE VIEW raw_unwrap_report AS (
        SELECT * FROM raw_report WHERE report_type = 'unwrap'
      );
    `);

    await db_query(`
        drop view if exists last_harvest_report_by_chain cascade;
        -- this is the most efficient top-k query
        CREATE OR REPLACE VIEW last_harvest_report_by_chain AS (
          (${allChainIds
              .map(chain => `SELECT * FROM raw_harvest_report WHERE chain = '${chain}' ORDER BY datetime DESC LIMIT 1`)
              .join(') UNION ALL (')})
        );
    `);

    await db_query(
        `
        drop view if exists chain cascade;
        CREATE OR REPLACE VIEW chain AS (
          SELECT 
            c.chain::chain_enum,
            (c.eol = 't')::boolean as eol,
            (unwrap_enabled = 't')::boolean as unwrap_enabled,
            unwrap_balance_gas_multiplier_threshold::double precision,
            unwrap_trigger_amount_wei::bigint,
            (harvest_enabled = 't')::boolean as harvest_enabled,
            (target_hours_between_harvests || ' hours')::interval as target_time_between_harvests,
            harvest_balance_gas_multiplier_threshold::double precision
          FROM (values %L) as c(
            chain, 
            eol, 
            unwrap_enabled,
            unwrap_balance_gas_multiplier_threshold,
            unwrap_trigger_amount_wei,
            harvest_enabled,
            target_hours_between_harvests,
            harvest_balance_gas_multiplier_threshold)
        );
    `,
        [
            allChainIds.map(c => [
                c,
                RPC_CONFIG[c].eol,
                RPC_CONFIG[c].unwrap.enabled,
                RPC_CONFIG[c].unwrap.balanceCheck.minWalletThreshold,
                RPC_CONFIG[c].unwrap.triggerAmountWei,
                RPC_CONFIG[c].harvest.enabled,
                RPC_CONFIG[c].harvest.targetTimeBetweenHarvestsMs / 1000 / 60 / 60,
                RPC_CONFIG[c].harvest.balanceCheck.minWalletThreshold,
            ]),
        ]
    );

    await db_query(`
      drop view if exists vault cascade;
      CREATE OR REPLACE VIEW vault AS (
        with vault_jsonb as (
          SELECT jsonb_path_query(r.report_content, '$.details[*].vault') as vault
          FROM last_harvest_report_by_chain r
        )
        select distinct(id)
          id, 
          eol, 
          chain, 
          hexstr_to_bytea("strategyAddress") as strategy_address, 
          "platformId" as platform_id,
          "tvlUsd" as tvl_usd
        from vault_jsonb, jsonb_to_record(vault) as vault(
          id character varying,
          eol boolean,
          chain chain_enum,
          "strategyAddress" character varying,
          "platformId" character varying,
          "tvlUsd" double precision
        )
      );
    `);

    await db_query(`
      drop view if exists cowllector_run cascade;
      CREATE OR REPLACE VIEW cowllector_run AS (
        select
        r.raw_report_id,
        r.chain,
        r.report_type,
        r.datetime,
        async_field_ok(d."fetchGasPrice") and async_field_ok(d."collectorBalanceBefore") and async_field_ok(d."collectorBalanceAfter") as run_ok,
        d."fetchGasPrice" is not null as fetch_gas_price_started,
        async_field_ok(d."fetchGasPrice") as fetch_gas_price_ok, 
        d."fetchGasPrice"->'reason' as fetch_gas_price_ko_reason,
        gas_ok."gasPriceWei" as fetch_gas_price_wei,
        d."collectorBalanceBefore" is not null as balance_before_started,
        async_field_ok(d."collectorBalanceBefore") as balance_before_ok,
        d."collectorBalanceBefore"->'reason' as balance_before_ko_reason,
        balance_before_ok."balanceWei" as balance_before_native_wei,
        balance_before_ok."wnativeBalanceWei" as balance_before_wnative_wei,
        balance_before_ok."aggregatedBalanceWei" as balance_before_aggregated_wei,
        d."collectorBalanceAfter" is not null as balance_after_started,
        async_field_ok(d."collectorBalanceAfter") as balance_after_ok,
        d."collectorBalanceAfter"->'reason' as balance_after_ko_reason,
        balance_after_ok."balanceWei" as balance_after_native_wei,
        balance_after_ok."wnativeBalanceWei" as balance_after_wnative_wei,
        balance_after_ok."aggregatedBalanceWei" as balance_after_aggregated_wei,
        summary."aggregatedProfitWei" as aggregated_profit_wei,
        summary."nativeGasUsedWei" as native_gas_used_wei,
        summary."wnativeProfitWei" as wnative_profit_wei,
        summary."harvested" as harvested,
        summary."skipped" as skipped,
        summary."totalStrategies" as total_strategies,
        summary."balanceWei" as native_balance_wei,
        summary."wnativeBalanceWei" as wnative_balance_wei,
        summary."aggregatedBalanceWei" as aggregated_balance_wei,
        status_count."not-started" as status_not_started,
        status_count."success" as status_count_success,
        status_count."warning" as status_count_warning,
        status_count."info" as status_count_info,
        status_count."notice" as status_count_notice,
        status_count."error" as status_count_error
      FROM 
        raw_report r, 
        jsonb_to_record(r.report_content) as d(
          "timing" jsonb,
          "fetchGasPrice" jsonb,
          "collectorBalanceBefore" jsonb,
          "collectorBalanceAfter" jsonb,
          "summary" jsonb
        ),
        jsonb_to_record(d."fetchGasPrice"->'value') as gas_ok(
          "gasPriceWei" numeric
        ),
        jsonb_to_record(d."collectorBalanceBefore"->'value') as balance_before_ok(
          "balanceWei" numeric,
          "wnativeBalanceWei" numeric,
          "aggregatedBalanceWei" numeric
        ),
        jsonb_to_record(d."collectorBalanceAfter"->'value') as balance_after_ok(
          "balanceWei" numeric,
          "wnativeBalanceWei" numeric,
          "aggregatedBalanceWei" numeric
        ),
        jsonb_to_record(d."summary") as summary(
          "aggregatedProfitWei" numeric,
          "nativeGasUsedWei" numeric,
          "wnativeProfitWei" numeric,
          "harvested" integer,
          "skipped" integer,
          "totalStrategies" integer,
          "balanceWei" numeric,
          "wnativeBalanceWei" numeric,
          "aggregatedBalanceWei" numeric,
          "statuses" jsonb
        ),
        jsonb_to_record(summary."statuses") as status_count(
          "not-started" integer,
          "success" integer,
          "warning" integer,
          "info" integer,
          "notice" integer,
          "error" integer
        )
      );
    `);

    await db_query(`
        drop view if exists last_harvest_run_by_chain cascade;
        -- this is the most efficient top-k query
        CREATE OR REPLACE VIEW last_harvest_run_by_chain AS (
          (${allChainIds
              .map(
                  chain =>
                      `SELECT * FROM cowllector_run WHERE chain = '${chain}' and report_type = 'harvest' ORDER BY datetime DESC LIMIT 1`
              )
              .join(') UNION ALL (')})
        );
    `);

    await db_query(`
      drop view if exists harvest_report_vault_details cascade;
      CREATE OR REPLACE VIEW harvest_report_vault_details AS (
        with vault_report_jsonb as (
          SELECT 
            r.raw_report_id,
            r.chain,
            r.datetime,
            async_field_ok(d."fetchGasPrice") and async_field_ok(d."collectorBalanceBefore") and async_field_ok(d."collectorBalanceAfter") as run_ok,
            async_field_ok(d."fetchGasPrice") as fetch_gas_price_ok, 
            async_field_ok(d."collectorBalanceBefore") as balance_before_ok,
            async_field_ok(d."collectorBalanceAfter") as balance_after_ok,
            jsonb_path_query(r.report_content, '$.details[*]') as vault_report
          FROM raw_harvest_report r,
            jsonb_to_record(r.report_content) as d(
              "timing" jsonb,
              "fetchGasPrice" jsonb,
              "collectorBalanceBefore" jsonb,
              "collectorBalanceAfter" jsonb,
              "summary" jsonb
            )
        ) 
        select 
          r.raw_report_id,
          r.chain,
          r.datetime,
          r.run_ok,
          r.fetch_gas_price_ok,
          r.balance_before_ok,
          r.balance_after_ok,
          d.vault->>'id' as vault_id,
          d.simulation is not null as simulation_started,
          async_field_ok(d.simulation) as simulation_ok,
          d.simulation->'reason' as simulation_ko_reason,
          sim_ok."lastHarvest" as simulation_last_harvest,
          sim_ok."hoursSinceLastHarvest" as simulation_hours_since_last_harvest,
          sim_ok."isLastHarvestRecent" as simulation_is_last_harvest_recent,
          sim_ok."paused" as simulation_paused,
          sim_ok."blockNumber" as simulation_block_number,
          sim_ok."harvestResultData" as simulation_harvest_result_data,
          gas."rawGasPrice" as simulation_gas_raw_gas_price,
          gas."rawGasAmountEstimation" as simulation_gas_raw_gas_amount_estimation,
          gas."estimatedCallRewardsWei" as simulation_gas_estimated_call_rewards_wei,
          gas."gasPriceMultiplier" as simulation_gas_gas_price_multiplier,
          gas."gasPrice" as simulation_gas_gas_price,
          gas."transactionCostEstimationWei" as simulation_gas_transaction_cost_estimation_wei,
          gas."estimatedGainWei" as simulation_gas_estimated_gain_wei,
          gas."wouldBeProfitable" as simulation_gas_would_be_profitable,
          d.decision is not null as decision_started,
          async_field_ok(d.decision) as decision_ok,
          d.decision->'reason' as decision_ko_reason,
          dec_ok."shouldHarvest" as decision_should_harvest,
          dec_ok."level" as decision_level,
          dec_ok."notHarvestingReason" as decision_not_harvesting_reason,
          d.transaction is not null as transaction_started,
          async_field_ok(d.transaction) as transaction_ok,
          d.transaction->'reason' as transaction_ko_reason,
          hexstr_to_bytea(tx."transactionHash") as transaction_hash,
          tx."blockNumber" as transaction_block_number,
          tx."gasUsed" as transaction_gas_used,
          tx."effectiveGasPrice" as transaction_effective_gas_price,
          tx."gasUsed" * tx."effectiveGasPrice" as transaction_gas_cost_wei,
          tx."balanceBeforeWei" as transaction_balance_before_wei,
          tx."estimatedProfitWei" as transaction_estimated_profit_wei,
          summary.harvested as summary_harvested,
          summary.skipped as summary_skipped,
          summary.status as summary_status,
          r.vault_report
        FROM 
          vault_report_jsonb r, 
          jsonb_to_record(r.vault_report) as d(
            vault jsonb,
            simulation jsonb,
            decision jsonb,
            transaction jsonb,
            summary jsonb
          ),
          jsonb_to_record(d.simulation->'value') as sim_ok(
            "estimatedCallRewardsWei" numeric,
            "gas" jsonb,
            "harvestWillSucceed" boolean,
            "lastHarvest" timestamp with time zone,
            "hoursSinceLastHarvest" double precision,
            "isLastHarvestRecent" boolean,
            "paused" boolean,
            "blockNumber" numeric,
            "harvestResultData" jsonb
          ),
          jsonb_to_record(sim_ok.gas) as gas(
            "rawGasPrice" numeric,
            "rawGasAmountEstimation" numeric,
            "estimatedCallRewardsWei" numeric,
            "gasPriceMultiplier" double precision,
            "gasPrice" numeric,
            "transactionCostEstimationWei" numeric,
            "estimatedGainWei" numeric,
            "wouldBeProfitable" boolean
          ),
          jsonb_to_record(d.decision->'value') as dec_ok(
            "shouldHarvest" boolean,
            "level" character varying,
            "notHarvestingReason" character varying
          ),
          jsonb_to_record(d.transaction->'value') as tx(
            "transactionHash" character varying,
            "blockNumber" numeric,
            "gasUsed" numeric,
            "effectiveGasPrice" numeric,
            "balanceBeforeWei" numeric,
            "estimatedProfitWei" numeric
          ),
          jsonb_to_record(d.summary) as summary(
            harvested boolean,
            skipped boolean,
            status character varying
          )
      );
    `);

    // helper view to get alerted when there is not enough balance left
    await db_query(`
      drop view if exists alert_enough_balance cascade;
      CREATE OR REPLACE VIEW alert_enough_balance AS (
        with transaction_max_cost as (
          select chain, max(transaction_gas_cost_wei) as max_trx_cost
          FROM harvest_report_vault_details
          WHERE datetime between now() - '14 day'::interval and now()
          GROUP BY chain
        ),
        balance_ok_by_chain as (
          select 
            c.chain,
            t.max_trx_cost,
            c.harvest_balance_gas_multiplier_threshold, 
            r.balance_after_native_wei,
            (t.max_trx_cost * c.harvest_balance_gas_multiplier_threshold) as balance_threshold_1,
            c.unwrap_trigger_amount_wei as balance_threshold_2,
            coalesce(
              r.balance_after_native_wei > (t.max_trx_cost * c.harvest_balance_gas_multiplier_threshold),
              r.balance_after_native_wei > c.unwrap_trigger_amount_wei, -- not "right" but a good default
              false
            ) as balance_ok
          FROM transaction_max_cost t 
          join chain c using (chain)
          join last_harvest_run_by_chain r using (chain)
          where not c.eol and c.harvest_enabled
        )
        select *
        from balance_ok_by_chain
      );
    `);

    // get alerted when a vault harvest is in error for too long (3 times default)
    // we don't want to get alerted on the first error because sometimes the trx goes through anyway
    await db_query(`
      drop view if exists alert_vault_harvest_in_error cascade;
      CREATE OR REPLACE VIEW alert_vault_harvest_in_error AS (
          SELECT
            r.datetime,
            r.vault_id,
            coalesce(r.summary_status != 'error', true) as success
          FROM
            harvest_report_vault_details r
      );
    `);

    // get an alert when a cowllector run was in error 3 times in a row, harvest or unwrap
    await db_query(`
      drop view if exists alert_run_in_error cascade;
      CREATE OR REPLACE VIEW alert_run_in_error AS (
        select 
          r.datetime,
          r.report_type || '-' || r.chain as report_key,
          r.run_ok as success
        from cowllector_run r
      );
    `);

    logger.info({ msg: 'Migrate done' });
}

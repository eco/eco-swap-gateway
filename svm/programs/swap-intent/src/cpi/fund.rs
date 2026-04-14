use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use portal::instructions::FundArgs;

use crate::constants::FUND_DISCRIMINATOR;

/// CPI into Portal's `fund` instruction.
///
/// Account layout matches `portal::instructions::Fund`:
///   0: payer (signer, writable)
///   1: funder (signer, writable)
///   2: vault (writable)
///   3: token_program
///   4: token_2022_program
///   5: associated_token_program
///   6: system_program
///   + remaining_accounts: chunks of [from_ata, vault_ata, mint]
pub fn fund<'info>(
    portal_program: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    funder: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    args: FundArgs,
) -> Result<()> {
    let ix_data: Vec<u8> = FUND_DISCRIMINATOR
        .into_iter()
        .chain(args.try_to_vec()?)
        .collect();

    let mut account_metas = vec![
        AccountMeta::new(payer.key(), true),
        AccountMeta::new(funder.key(), true),
        AccountMeta::new(vault.key(), false),
        AccountMeta::new_readonly(token_program.key(), false),
        AccountMeta::new_readonly(token_2022_program.key(), false),
        AccountMeta::new_readonly(associated_token_program.key(), false),
        AccountMeta::new_readonly(system_program.key(), false),
    ];

    for account in remaining_accounts {
        account_metas.push(AccountMeta {
            pubkey: account.key(),
            is_signer: account.is_signer,
            is_writable: account.is_writable,
        });
    }

    let ix = Instruction::new_with_bytes(portal_program.key(), &ix_data, account_metas);

    let mut account_infos = vec![
        payer.to_account_info(),
        funder.to_account_info(),
        vault.to_account_info(),
        token_program.to_account_info(),
        token_2022_program.to_account_info(),
        associated_token_program.to_account_info(),
        system_program.to_account_info(),
    ];
    account_infos.extend(
        remaining_accounts
            .iter()
            .map(ToAccountInfo::to_account_info),
    );

    invoke(&ix, &account_infos).map_err(Into::into)
}

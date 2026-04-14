use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;
use portal::instructions::PublishArgs;

use crate::constants::PUBLISH_DISCRIMINATOR;

/// CPI into Portal's `publish` instruction.
///
/// Portal's Publish context has zero accounts — it only hashes the route
/// and emits an IntentPublished event.
pub fn publish(portal_program: &AccountInfo, args: PublishArgs) -> Result<()> {
    let ix_data: Vec<u8> = PUBLISH_DISCRIMINATOR
        .into_iter()
        .chain(args.try_to_vec()?)
        .collect();

    let ix = Instruction::new_with_bytes(portal_program.key(), &ix_data, vec![]);

    invoke(&ix, &[portal_program.to_account_info()]).map_err(Into::into)
}

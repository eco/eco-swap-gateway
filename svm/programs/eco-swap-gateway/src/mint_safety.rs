use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022MintState;

use crate::errors::GatewayError;

/// Asserts that `mint` is safe to use as the reward token.
///
/// SPL Token mints are unconditionally accepted (the legacy program has no
/// extension mechanism). Token-2022 mints are accepted iff none of the
/// following extensions are present on the mint:
///
/// - `TransferFeeConfig` — would under-fund the vault.
/// - `TransferHook` — CPI would need user-chosen accounts we didn't declare.
/// - `InterestBearingConfig` — balance accrues between open and close.
/// - `PermanentDelegate` — third party can drain the ATA mid-tx.
/// - `ConfidentialTransferMint` — encrypted balances break delta math.
/// - `NonTransferable` — fund CPI would revert.
/// - `DefaultAccountState` — default-frozen mints block transfers.
///
/// Benign extensions (metadata, group, member, memo transfer, close authority,
/// etc.) pass through. See DESIGN.md §"Mint safety" for per-extension rationale.
pub fn require_safe_mint(mint: &AccountInfo) -> Result<()> {
    if *mint.owner == anchor_spl::token::ID {
        return Ok(());
    }
    require!(
        *mint.owner == anchor_spl::token_2022::ID,
        GatewayError::MintMismatch
    );

    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022MintState>::unpack(&data)
        .map_err(|_| error!(GatewayError::UnsafeMintExtension))?;
    let extensions = state
        .get_extension_types()
        .map_err(|_| error!(GatewayError::UnsafeMintExtension))?;

    for ext in extensions {
        match ext {
            ExtensionType::TransferFeeConfig
            | ExtensionType::TransferHook
            | ExtensionType::InterestBearingConfig
            | ExtensionType::PermanentDelegate
            | ExtensionType::ConfidentialTransferMint
            | ExtensionType::NonTransferable
            | ExtensionType::DefaultAccountState => {
                return err!(GatewayError::UnsafeMintExtension);
            }
            _ => {}
        }
    }

    Ok(())
}

use anchor_lang::prelude::*;

mod cancel;
mod close_and_create;
mod open;

pub use cancel::*;
pub use close_and_create::*;
pub use open::*;

#[error_code]
pub enum SwapIntentError {
    #[msg("Swap output is zero or insufficient")]
    InsufficientSwapOutput,
    #[msg("Invalid scalar parameters (denom=0, num>denom, or num=0)")]
    InvalidScalar,
    #[msg("Route amount is zero after fee calculation")]
    RouteAmountZero,
    #[msg("Output mint does not match swap state")]
    InvalidMint,
    #[msg("User does not match swap state")]
    InvalidUser,
    #[msg("Vault PDA does not match expected derivation")]
    InvalidVault,
    #[msg("Route template offset out of bounds")]
    OffsetOutOfBounds,
    #[msg("Arithmetic overflow in fee calculation")]
    ArithmeticOverflow,
    #[msg("Portal program ID does not match expected program")]
    InvalidPortalProgram,
    #[msg("Token account does not match the one recorded at open time")]
    InvalidTokenAccount,
    #[msg("Remaining accounts length must be a multiple of 3 (from_ata, vault_ata, mint)")]
    InvalidRemainingAccounts,
    #[msg("Reward amount exceeds swap output")]
    RewardExceedsSwapOutput,
}

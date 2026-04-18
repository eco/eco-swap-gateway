use anchor_lang::prelude::*;

mod close_route_buffer;
mod create_intent;
mod write_route_buffer;

pub use close_route_buffer::*;
pub use create_intent::*;
pub use write_route_buffer::*;

#[error_code]
pub enum IntentPublisherError {
    #[msg("User does not match expected PDA owner")]
    InvalidUser,
    #[msg("Vault PDA does not match expected derivation")]
    InvalidVault,
    #[msg("Portal program ID does not match expected program")]
    InvalidPortalProgram,
    #[msg("Remaining accounts length must be a multiple of 3 (from_ata, vault_ata, mint)")]
    InvalidRemainingAccounts,
}

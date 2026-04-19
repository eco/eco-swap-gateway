use anchor_lang::prelude::*;

mod close_route_buffer;
mod create_intent;
mod write_route_buffer;

pub use close_route_buffer::*;
pub use create_intent::*;
pub use write_route_buffer::*;

#[error_code]
pub enum IntentPublisherError {
    #[msg("Route exceeds maximum length of 1024 bytes")]
    RouteTooLong,
}

use anchor_lang::AnchorSerialize;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account;
use anchor_spl::token::spl_token;
use eco_svm_std::Bytes32;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::{AccountMeta, Instruction, InstructionError};
use solana_sdk::message::Message;
use solana_sdk::program_pack::Pack;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::system_program;
use solana_sdk::transaction::{Transaction, TransactionError};
use tiny_keccak::{Hasher, Keccak};

const COMPUTE_UNIT_LIMIT: u32 = 400_000;
const PORTAL_BIN: &[u8] = include_bytes!("../../../../../eco-routes-svm/target/deploy/portal.so");
const SWAP_INTENT_BIN: &[u8] = include_bytes!("../../../target/deploy/swap_intent.so");

type TransactionResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

pub struct Context {
    pub svm: LiteSVM,
    pub mint_authority: Keypair,
    pub user: Keypair,
    pub mint: Pubkey,
}

impl Context {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();

        svm.add_program(portal::ID, PORTAL_BIN);
        svm.add_program(swap_intent::ID, SWAP_INTENT_BIN);

        let mint_authority = Keypair::new();
        let user = Keypair::new();

        svm.airdrop(&mint_authority.pubkey(), 100_000_000_000)
            .unwrap();
        svm.airdrop(&user.pubkey(), 10_000_000_000).unwrap();

        let mint = Keypair::new();
        let mint_pubkey = mint.pubkey();

        // Create mint
        let rent = svm.get_sysvar::<Rent>();
        let create_mint_ix = solana_sdk::system_instruction::create_account(
            &mint_authority.pubkey(),
            &mint_pubkey,
            rent.minimum_balance(spl_token::state::Mint::LEN),
            spl_token::state::Mint::LEN as u64,
            &spl_token::ID,
        );
        let init_mint_ix = spl_token::instruction::initialize_mint(
            &spl_token::ID,
            &mint_pubkey,
            &mint_authority.pubkey(),
            None,
            6,
        )
        .unwrap();

        let tx = Transaction::new(
            &[&mint_authority, &mint],
            Message::new(
                &[create_mint_ix, init_mint_ix],
                Some(&mint_authority.pubkey()),
            ),
            svm.latest_blockhash(),
        );
        svm.send_transaction(tx).unwrap();

        // Create user's ATA
        let create_ata_ix = create_associated_token_account(
            &mint_authority.pubkey(),
            &user.pubkey(),
            &mint_pubkey,
            &spl_token::ID,
        );
        let tx = Transaction::new(
            &[&mint_authority],
            Message::new(&[create_ata_ix], Some(&mint_authority.pubkey())),
            svm.latest_blockhash(),
        );
        svm.send_transaction(tx).unwrap();

        Self {
            svm,
            mint_authority,
            user,
            mint: mint_pubkey,
        }
    }

    pub fn user_ata(&self) -> Pubkey {
        get_associated_token_address(&self.user.pubkey(), &self.mint)
    }

    pub fn mint_to_user(&mut self, amount: u64) {
        let user_ata = self.user_ata();
        let ix = spl_token::instruction::mint_to(
            &spl_token::ID,
            &self.mint,
            &user_ata,
            &self.mint_authority.pubkey(),
            &[],
            amount,
        )
        .unwrap();
        let tx = Transaction::new(
            &[&self.mint_authority],
            Message::new(&[ix], Some(&self.mint_authority.pubkey())),
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).unwrap();
    }

    pub fn token_balance(&self, ata: &Pubkey) -> u64 {
        self.svm
            .get_account(ata)
            .and_then(|account| {
                spl_token::state::Account::unpack(&account.data)
                    .ok()
                    .map(|a| a.amount)
            })
            .unwrap_or(0)
    }

    pub fn swap_state_pda(&self) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"swap_state", self.user.pubkey().as_ref()],
            &swap_intent::ID,
        )
    }

    pub fn account_exists(&self, pubkey: &Pubkey) -> bool {
        self.svm
            .get_account(pubkey)
            .map(|a| a.lamports > 0)
            .unwrap_or(false)
    }

    /// Build the `open` instruction.
    pub fn open_ix(&self) -> Instruction {
        let (swap_state, _) = self.swap_state_pda();
        let data = anchor_discriminator("open");

        Instruction::new_with_bytes(
            swap_intent::ID,
            &data,
            vec![
                AccountMeta::new(self.user.pubkey(), true),
                AccountMeta::new_readonly(self.user_ata(), false),
                AccountMeta::new(swap_state, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )
    }

    /// Build the `cancel` instruction.
    pub fn cancel_ix(&self) -> Instruction {
        let (swap_state, _) = self.swap_state_pda();
        let data = anchor_discriminator("cancel");

        Instruction::new_with_bytes(
            swap_intent::ID,
            &data,
            vec![
                AccountMeta::new(self.user.pubkey(), true),
                AccountMeta::new(swap_state, false),
            ],
        )
    }

    /// Build the `close_and_create_intent` instruction.
    ///
    /// `pre_balance` is needed to compute the expected route_amount and vault PDA.
    pub fn close_and_create_ix(
        &self,
        pre_balance: u64,
        post_balance: u64,
        flat_fee: u64,
        scalar_num: u64,
        scalar_denom: u64,
    ) -> Instruction {
        let swap_output = post_balance - pre_balance;
        let route_amount = swap_output * scalar_num / scalar_denom - flat_fee;
        let destination: u64 = 1; // Ethereum mainnet

        // Build route template: 128 bytes with known offsets for patching
        // tokens_amount at offset 32, calldata_amount at offset 96
        let mut route_template = vec![0u8; 128];
        // Patch expected amounts so we can compute the hash
        let amount_bytes = to_be_uint256(route_amount);
        route_template[32..64].copy_from_slice(&amount_bytes);
        route_template[96..128].copy_from_slice(&amount_bytes);

        let route_hash = keccak256(&route_template);

        let reward = portal::types::Reward {
            deadline: u64::MAX,
            creator: self.user.pubkey(),
            prover: Pubkey::new_unique(),
            native_amount: 0,
            tokens: vec![portal::types::TokenAmount {
                token: self.mint,
                amount: swap_output,
            }],
        };
        let reward_hash = reward.hash();
        let intent_hash = portal::types::intent_hash(destination, &route_hash, &reward_hash);

        let (vault, _) = portal::state::vault_pda(&intent_hash);
        let vault_ata = get_associated_token_address(&vault, &self.mint);
        let (swap_state, _) = self.swap_state_pda();

        // Build args (before patching — program patches the template)
        let unpatched_template = vec![0u8; 128];
        // Leave zeros as placeholder — program will overwrite

        let args = swap_intent::instructions::CreateIntentArgs {
            destination,
            route_template: unpatched_template,
            tokens_amount_offset: 32,
            calldata_amount_offset: 96,
            reward_deadline: u64::MAX,
            reward_creator: self.user.pubkey(),
            reward_prover: reward.prover,
            reward_token: self.mint,
            flat_fee,
            scalar_num,
            scalar_denom,
            allow_partial: false,
            extra_calls: vec![],
        };

        let mut data = anchor_discriminator("close_and_create_intent");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        Instruction::new_with_bytes(
            swap_intent::ID,
            &data,
            vec![
                AccountMeta::new(self.user.pubkey(), true),
                AccountMeta::new(swap_state, false),
                AccountMeta::new_readonly(self.user_ata(), false),
                AccountMeta::new_readonly(portal::ID, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(spl_token::ID, false),
                AccountMeta::new_readonly(anchor_spl::token_2022::ID, false),
                AccountMeta::new_readonly(anchor_spl::associated_token::ID, false),
                AccountMeta::new_readonly(system_program::ID, false),
                // remaining_accounts: from_ata, vault_ata, mint
                AccountMeta::new(self.user_ata(), false),
                AccountMeta::new(vault_ata, false),
                AccountMeta::new_readonly(self.mint, false),
            ],
        )
    }

    /// Build close_and_create_intent with calldata patching skipped (Case 3).
    pub fn close_and_create_ix_skip_calldata(
        &self,
        pre_balance: u64,
        post_balance: u64,
        flat_fee: u64,
        scalar_num: u64,
        scalar_denom: u64,
    ) -> Instruction {
        let swap_output = post_balance - pre_balance;
        let route_amount = swap_output * scalar_num / scalar_denom - flat_fee;
        let destination: u64 = 1;

        // Route template: only offset 32 is patched, bytes 96..128 are left as-is
        let mut route_template = vec![0xABu8; 128]; // non-zero fill to prove calldata isn't touched
        let amount_bytes = to_be_uint256(route_amount);
        route_template[32..64].copy_from_slice(&amount_bytes);
        // bytes 96..128 stay 0xAB (pre-encoded calldata, NOT patched)

        let route_hash = keccak256(&route_template);

        let reward = portal::types::Reward {
            deadline: u64::MAX,
            creator: self.user.pubkey(),
            prover: Pubkey::new_unique(),
            native_amount: 0,
            tokens: vec![portal::types::TokenAmount {
                token: self.mint,
                amount: swap_output,
            }],
        };
        let reward_hash = reward.hash();
        let intent_hash = portal::types::intent_hash(destination, &route_hash, &reward_hash);

        let (vault, _) = portal::state::vault_pda(&intent_hash);
        let vault_ata = get_associated_token_address(&vault, &self.mint);
        let (swap_state, _) = self.swap_state_pda();

        // Unpatched template with 0xAB fill
        let unpatched_template = vec![0xABu8; 128];

        let args = swap_intent::instructions::CreateIntentArgs {
            destination,
            route_template: unpatched_template,
            tokens_amount_offset: 32,
            calldata_amount_offset: u32::MAX, // sentinel: skip calldata patch
            reward_deadline: u64::MAX,
            reward_creator: self.user.pubkey(),
            reward_prover: reward.prover,
            reward_token: self.mint,
            flat_fee,
            scalar_num,
            scalar_denom,
            allow_partial: false,
            extra_calls: vec![],
        };

        let mut data = anchor_discriminator("close_and_create_intent");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        Instruction::new_with_bytes(
            swap_intent::ID,
            &data,
            vec![
                AccountMeta::new(self.user.pubkey(), true),
                AccountMeta::new(swap_state, false),
                AccountMeta::new_readonly(self.user_ata(), false),
                AccountMeta::new_readonly(portal::ID, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(spl_token::ID, false),
                AccountMeta::new_readonly(anchor_spl::token_2022::ID, false),
                AccountMeta::new_readonly(anchor_spl::associated_token::ID, false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(self.user_ata(), false),
                AccountMeta::new(vault_ata, false),
                AccountMeta::new_readonly(self.mint, false),
            ],
        )
    }

    /// Build close_and_create_intent for error cases where we expect early failure
    /// (before vault PDA validation). Uses a dummy vault since the tx will revert.
    pub fn close_and_create_ix_error_case(
        &self,
        flat_fee: u64,
        scalar_num: u64,
        scalar_denom: u64,
    ) -> Instruction {
        let (swap_state, _) = self.swap_state_pda();
        let dummy_vault = Pubkey::new_unique();
        let vault_ata = get_associated_token_address(&dummy_vault, &self.mint);

        let args = swap_intent::instructions::CreateIntentArgs {
            destination: 1,
            route_template: vec![0u8; 128],
            tokens_amount_offset: 32,
            calldata_amount_offset: 96,
            reward_deadline: u64::MAX,
            reward_creator: self.user.pubkey(),
            reward_prover: Pubkey::new_unique(),
            reward_token: self.mint,
            flat_fee,
            scalar_num,
            scalar_denom,
            allow_partial: false,
            extra_calls: vec![],
        };

        let mut data = anchor_discriminator("close_and_create_intent");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        Instruction::new_with_bytes(
            swap_intent::ID,
            &data,
            vec![
                AccountMeta::new(self.user.pubkey(), true),
                AccountMeta::new(swap_state, false),
                AccountMeta::new_readonly(self.user_ata(), false),
                AccountMeta::new_readonly(portal::ID, false),
                AccountMeta::new(dummy_vault, false),
                AccountMeta::new_readonly(spl_token::ID, false),
                AccountMeta::new_readonly(anchor_spl::token_2022::ID, false),
                AccountMeta::new_readonly(anchor_spl::associated_token::ID, false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(self.user_ata(), false),
                AccountMeta::new(vault_ata, false),
                AccountMeta::new_readonly(self.mint, false),
            ],
        )
    }

    pub fn send(&mut self, ixs: &[Instruction]) -> TransactionResult {
        let mut all_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(
            COMPUTE_UNIT_LIMIT,
        )];
        all_ixs.extend_from_slice(ixs);

        let tx = Transaction::new(
            &[&self.user],
            Message::new(&all_ixs, Some(&self.user.pubkey())),
            self.svm.latest_blockhash(),
        );
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        result.map_err(Box::new)
    }
}

fn anchor_discriminator(name: &str) -> Vec<u8> {
    let full = format!("global:{}", name);
    let hash = solana_sdk::hash::hash(full.as_bytes());
    hash.to_bytes()[..8].to_vec()
}

fn to_be_uint256(value: u64) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[24..32].copy_from_slice(&value.to_be_bytes());
    bytes
}

fn keccak256(data: &[u8]) -> Bytes32 {
    let mut hasher = Keccak::v256();
    let mut hash = [0u8; 32];
    hasher.update(data);
    hasher.finalize(&mut hash);
    hash.into()
}

pub fn is_custom_error(result: &Box<FailedTransactionMetadata>, expected_code: u32) -> bool {
    matches!(
        result.err,
        TransactionError::InstructionError(_, InstructionError::Custom(code)) if code == expected_code
    )
}

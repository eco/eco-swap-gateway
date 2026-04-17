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

    pub fn route_buffer_pda(&self) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"route_buffer", self.user.pubkey().as_ref()],
            &swap_intent::ID,
        )
    }

    pub fn account_exists(&self, pubkey: &Pubkey) -> bool {
        self.svm
            .get_account(pubkey)
            .map(|a| a.lamports > 0)
            .unwrap_or(false)
    }

    // ── Instruction builders ───────────────────────────────────────────

    pub fn write_route_buffer_ix(
        &self,
        route_template: Vec<u8>,
        tokens_amount_offset: u32,
        calldata_amount_offset: u32,
    ) -> Instruction {
        let (route_buffer, _) = self.route_buffer_pda();

        let args = swap_intent::instructions::WriteRouteBufferArgs {
            route_template,
            tokens_amount_offset,
            calldata_amount_offset,
        };

        let mut data = anchor_discriminator("write_route_buffer");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        Instruction::new_with_bytes(
            swap_intent::ID,
            &data,
            vec![
                AccountMeta::new(self.user.pubkey(), true),
                AccountMeta::new(route_buffer, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )
    }

    /// Write a default 128-byte route buffer with standard offsets (32, 96).
    pub fn write_default_route_buffer(&mut self) {
        let ix = self.write_route_buffer_ix(vec![0u8; 128], 32, 96);
        self.send(&[ix]).unwrap();
    }

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

    /// Build close_and_create_intent. Route template is read from the route buffer PDA.
    pub fn close_and_create_ix(
        &self,
        pre_balance: u64,
        post_balance: u64,
        flat_fee: u64,
        scalar_num: u64,
        scalar_denom: u64,
        source_decimals: u8,
        destination_decimals: u8,
        reward_amount: u64,
    ) -> Instruction {
        let swap_output = post_balance - pre_balance;
        let actual_reward = if reward_amount == 0 {
            swap_output
        } else {
            reward_amount
        };
        let net_amount = swap_output * scalar_num / scalar_denom - flat_fee;
        let route_amount =
            convert_decimals(net_amount as u128, source_decimals, destination_decimals);
        let destination: u64 = 1;

        // Compute expected route hash (same template as written to buffer, but patched)
        let mut route_template = vec![0u8; 128];
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
                amount: actual_reward,
            }],
        };
        let reward_hash = reward.hash();
        let intent_hash = portal::types::intent_hash(destination, &route_hash, &reward_hash);

        let (vault, _) = portal::state::vault_pda(&intent_hash);
        let vault_ata = get_associated_token_address(&vault, &self.mint);

        self.build_close_ix(
            vault,
            vault_ata,
            reward.prover,
            reward_amount,
            flat_fee,
            scalar_num,
            scalar_denom,
            source_decimals,
            destination_decimals,
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
        source_decimals: u8,
        destination_decimals: u8,
        reward_amount: u64,
    ) -> Instruction {
        let swap_output = post_balance - pre_balance;
        let actual_reward = if reward_amount == 0 {
            swap_output
        } else {
            reward_amount
        };
        let net_amount = swap_output * scalar_num / scalar_denom - flat_fee;
        let route_amount =
            convert_decimals(net_amount as u128, source_decimals, destination_decimals);
        let destination: u64 = 1;

        // Only offset 32 is patched, bytes 96..128 stay 0xAB
        let mut route_template = vec![0xABu8; 128];
        let amount_bytes = to_be_uint256(route_amount);
        route_template[32..64].copy_from_slice(&amount_bytes);
        let route_hash = keccak256(&route_template);

        let reward = portal::types::Reward {
            deadline: u64::MAX,
            creator: self.user.pubkey(),
            prover: Pubkey::new_unique(),
            native_amount: 0,
            tokens: vec![portal::types::TokenAmount {
                token: self.mint,
                amount: actual_reward,
            }],
        };
        let reward_hash = reward.hash();
        let intent_hash = portal::types::intent_hash(destination, &route_hash, &reward_hash);

        let (vault, _) = portal::state::vault_pda(&intent_hash);
        let vault_ata = get_associated_token_address(&vault, &self.mint);

        self.build_close_ix(
            vault,
            vault_ata,
            reward.prover,
            reward_amount,
            flat_fee,
            scalar_num,
            scalar_denom,
            source_decimals,
            destination_decimals,
        )
    }

    /// Build close_and_create_intent for error cases (dummy vault, will revert before validation).
    pub fn close_and_create_ix_error_case(
        &self,
        flat_fee: u64,
        scalar_num: u64,
        scalar_denom: u64,
        source_decimals: u8,
        destination_decimals: u8,
    ) -> Instruction {
        let dummy_vault = Pubkey::new_unique();
        let vault_ata = get_associated_token_address(&dummy_vault, &self.mint);

        self.build_close_ix(
            dummy_vault,
            vault_ata,
            Pubkey::new_unique(),
            0,
            flat_fee,
            scalar_num,
            scalar_denom,
            source_decimals,
            destination_decimals,
        )
    }

    pub fn close_and_create_ix_wrong_reward_token(&self) -> Instruction {
        let dummy_vault = Pubkey::new_unique();
        let vault_ata = get_associated_token_address(&dummy_vault, &self.mint);
        let (swap_state, _) = self.swap_state_pda();
        let (route_buffer, _) = self.route_buffer_pda();

        let args = swap_intent::instructions::CreateIntentArgs {
            destination: 1,
            reward_deadline: u64::MAX,
            reward_creator: self.user.pubkey(),
            reward_prover: Pubkey::new_unique(),
            reward_token: Pubkey::new_unique(), // deliberately wrong
            reward_amount: 0,
            flat_fee: 0,
            scalar_num: 1,
            scalar_denom: 1,
            source_decimals: 6,
            destination_decimals: 6,
            allow_partial: false,
        };

        let mut data = anchor_discriminator("close_and_create_intent");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        Instruction::new_with_bytes(
            swap_intent::ID,
            &data,
            self.close_accounts(swap_state, route_buffer, dummy_vault, vault_ata),
        )
    }

    pub fn close_and_create_ix_wrong_token_account(&self, wrong_ata: Pubkey) -> Instruction {
        let dummy_vault = Pubkey::new_unique();
        let vault_ata = get_associated_token_address(&dummy_vault, &self.mint);
        let (swap_state, _) = self.swap_state_pda();
        let (route_buffer, _) = self.route_buffer_pda();

        let args = swap_intent::instructions::CreateIntentArgs {
            destination: 1,
            reward_deadline: u64::MAX,
            reward_creator: self.user.pubkey(),
            reward_prover: Pubkey::new_unique(),
            reward_token: self.mint,
            reward_amount: 0,
            flat_fee: 0,
            scalar_num: 1,
            scalar_denom: 1,
            source_decimals: 6,
            destination_decimals: 6,
            allow_partial: false,
        };

        let mut data = anchor_discriminator("close_and_create_intent");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        // Override the output_token_account with wrong_ata
        let mut accounts = self.close_accounts(swap_state, route_buffer, dummy_vault, vault_ata);
        accounts[3] = AccountMeta::new_readonly(wrong_ata, false); // position of output_token_account
        Instruction::new_with_bytes(swap_intent::ID, &data, accounts)
    }

    pub fn close_and_create_ix_error_case_with_reward(&self, reward_amount: u64) -> Instruction {
        let dummy_vault = Pubkey::new_unique();
        let vault_ata = get_associated_token_address(&dummy_vault, &self.mint);

        self.build_close_ix(
            dummy_vault,
            vault_ata,
            Pubkey::new_unique(),
            reward_amount,
            0,
            1,
            1,
            6,
            6,
        )
    }

    pub fn cancel_ix_wrong_user(&self, attacker: &Keypair) -> Instruction {
        let (swap_state, _) = self.swap_state_pda();
        let data = anchor_discriminator("cancel");

        Instruction::new_with_bytes(
            swap_intent::ID,
            &data,
            vec![
                AccountMeta::new(attacker.pubkey(), true),
                AccountMeta::new(swap_state, false),
            ],
        )
    }

    pub fn send_as(&mut self, signer: &Keypair, ixs: &[Instruction]) -> TransactionResult {
        let mut all_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(
            COMPUTE_UNIT_LIMIT,
        )];
        all_ixs.extend_from_slice(ixs);

        let tx = Transaction::new(
            &[signer],
            Message::new(&all_ixs, Some(&signer.pubkey())),
            self.svm.latest_blockhash(),
        );
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        result.map_err(Box::new)
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

    // ── Private helpers ────────────────────────────────────────────────

    fn build_close_ix(
        &self,
        vault: Pubkey,
        vault_ata: Pubkey,
        reward_prover: Pubkey,
        reward_amount: u64,
        flat_fee: u64,
        scalar_num: u64,
        scalar_denom: u64,
        source_decimals: u8,
        destination_decimals: u8,
    ) -> Instruction {
        let (swap_state, _) = self.swap_state_pda();
        let (route_buffer, _) = self.route_buffer_pda();

        let args = swap_intent::instructions::CreateIntentArgs {
            destination: 1,
            reward_deadline: u64::MAX,
            reward_creator: self.user.pubkey(),
            reward_prover,
            reward_token: self.mint,
            reward_amount,
            flat_fee,
            scalar_num,
            scalar_denom,
            source_decimals,
            destination_decimals,
            allow_partial: false,
        };

        let mut data = anchor_discriminator("close_and_create_intent");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        Instruction::new_with_bytes(
            swap_intent::ID,
            &data,
            self.close_accounts(swap_state, route_buffer, vault, vault_ata),
        )
    }

    fn close_accounts(
        &self,
        swap_state: Pubkey,
        route_buffer: Pubkey,
        vault: Pubkey,
        vault_ata: Pubkey,
    ) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.user.pubkey(), true),
            AccountMeta::new(swap_state, false),
            AccountMeta::new(route_buffer, false),
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
        ]
    }
}

fn anchor_discriminator(name: &str) -> Vec<u8> {
    let full = format!("global:{}", name);
    let hash = solana_sdk::hash::hash(full.as_bytes());
    hash.to_bytes()[..8].to_vec()
}

fn to_be_uint256(value: u128) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[16..32].copy_from_slice(&value.to_be_bytes());
    bytes
}

fn convert_decimals(amount: u128, source_decimals: u8, destination_decimals: u8) -> u128 {
    if source_decimals > destination_decimals {
        amount / 10u128.pow((source_decimals - destination_decimals) as u32)
    } else if destination_decimals > source_decimals {
        amount * 10u128.pow((destination_decimals - source_decimals) as u32)
    } else {
        amount
    }
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

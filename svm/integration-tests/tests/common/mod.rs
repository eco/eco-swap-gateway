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
const PORTAL_BIN: &[u8] = include_bytes!("../../fixtures/portal.so");
const INTENT_PUBLISHER_BIN: &[u8] = include_bytes!("../../../target/deploy/intent_publisher.so");

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
        svm.add_program(intent_publisher::ID, INTENT_PUBLISHER_BIN);

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

    pub fn route_buffer_pda(&self) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"route_buffer", self.user.pubkey().as_ref()],
            &intent_publisher::ID,
        )
    }

    pub fn account_exists(&self, pubkey: &Pubkey) -> bool {
        self.svm
            .get_account(pubkey)
            .map(|a| a.lamports > 0)
            .unwrap_or(false)
    }

    // ── Instruction builders ───────────────────────────────────────────

    pub fn write_route_buffer_ix(&self, route: Vec<u8>) -> Instruction {
        let (route_buffer, _) = self.route_buffer_pda();
        let args = intent_publisher::instructions::WriteRouteBufferArgs { route };

        let mut data = anchor_discriminator("write_route_buffer");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        Instruction::new_with_bytes(
            intent_publisher::ID,
            &data,
            vec![
                AccountMeta::new(self.user.pubkey(), true),
                AccountMeta::new(route_buffer, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )
    }

    pub fn write_default_route_buffer(&mut self) {
        let ix = self.write_route_buffer_ix(vec![0u8; 128]);
        self.send(&[ix]).unwrap();
    }

    pub fn close_route_buffer_ix(&self) -> Instruction {
        let (route_buffer, _) = self.route_buffer_pda();
        let data = anchor_discriminator("close_route_buffer");

        Instruction::new_with_bytes(
            intent_publisher::ID,
            &data,
            vec![
                AccountMeta::new(self.user.pubkey(), true),
                AccountMeta::new(route_buffer, false),
            ],
        )
    }

    pub fn close_route_buffer_ix_as(&self, attacker: &Pubkey) -> Instruction {
        let (route_buffer, _) = self.route_buffer_pda();
        let data = anchor_discriminator("close_route_buffer");

        Instruction::new_with_bytes(
            intent_publisher::ID,
            &data,
            vec![
                AccountMeta::new(*attacker, true),
                AccountMeta::new(route_buffer, false),
            ],
        )
    }

    pub fn create_intent_ix(&self, route: Vec<u8>, reward_amount: u64) -> Instruction {
        let reward = self.build_reward(reward_amount);
        let (vault, vault_ata) = self.derive_vault(&route, &reward);

        let args = intent_publisher::instructions::CreateIntentArgs {
            destination: 1,
            route,
            reward,
            allow_partial: false,
        };

        let mut data = anchor_discriminator("create_intent");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        Instruction::new_with_bytes(
            intent_publisher::ID,
            &data,
            self.create_intent_accounts(vault, vault_ata),
        )
    }

    pub fn create_intent_from_buffer_ix(
        &self,
        route_for_hash: &[u8],
        reward_amount: u64,
    ) -> Instruction {
        let reward = self.build_reward(reward_amount);
        let (vault, vault_ata) = self.derive_vault(route_for_hash, &reward);

        let args = intent_publisher::instructions::CreateIntentFromBufferArgs {
            destination: 1,
            reward,
            allow_partial: false,
        };

        let mut data = anchor_discriminator("create_intent_from_buffer");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        let (route_buffer, _) = self.route_buffer_pda();
        let mut accounts = vec![
            AccountMeta::new(self.user.pubkey(), true),
            AccountMeta::new(route_buffer, false),
        ];
        accounts.extend(self.portal_and_remaining_accounts(vault, vault_ata));

        Instruction::new_with_bytes(intent_publisher::ID, &data, accounts)
    }

    pub fn create_intent_from_buffer_ix_as(
        &self,
        attacker: &Pubkey,
        reward_amount: u64,
    ) -> Instruction {
        let route = vec![0u8; 128];
        let reward = portal::types::Reward {
            deadline: u64::MAX,
            creator: *attacker,
            prover: Pubkey::new_unique(),
            native_amount: 0,
            tokens: vec![portal::types::TokenAmount {
                token: self.mint,
                amount: reward_amount,
            }],
        };
        let (vault, vault_ata) = self.derive_vault(&route, &reward);

        let args = intent_publisher::instructions::CreateIntentFromBufferArgs {
            destination: 1,
            reward,
            allow_partial: false,
        };

        let mut data = anchor_discriminator("create_intent_from_buffer");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        let (route_buffer, _) = self.route_buffer_pda();
        let mut accounts = vec![
            AccountMeta::new(*attacker, true),
            AccountMeta::new(route_buffer, false),
        ];
        accounts.extend(self.portal_and_remaining_accounts(vault, vault_ata));

        Instruction::new_with_bytes(intent_publisher::ID, &data, accounts)
    }

    // ── Transaction senders ───────────────────────────────────────────

    pub fn send(&mut self, ixs: &[Instruction]) -> TransactionResult {
        self.send_as(&self.user.insecure_clone(), ixs)
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

    // ── Private helpers ────────────────────────────────────────────────

    fn build_reward(&self, amount: u64) -> portal::types::Reward {
        portal::types::Reward {
            deadline: u64::MAX,
            creator: self.user.pubkey(),
            prover: Pubkey::new_unique(),
            native_amount: 0,
            tokens: vec![portal::types::TokenAmount {
                token: self.mint,
                amount,
            }],
        }
    }

    fn derive_vault(&self, route: &[u8], reward: &portal::types::Reward) -> (Pubkey, Pubkey) {
        let route_hash = keccak256(route);
        let reward_hash = reward.hash();
        let intent_hash = portal::types::intent_hash(1, &route_hash, &reward_hash);
        let (vault, _) = portal::state::vault_pda(&intent_hash);
        let vault_ata = get_associated_token_address(&vault, &self.mint);
        (vault, vault_ata)
    }

    fn create_intent_accounts(&self, vault: Pubkey, vault_ata: Pubkey) -> Vec<AccountMeta> {
        let mut accounts = vec![AccountMeta::new(self.user.pubkey(), true)];
        accounts.extend(self.portal_and_remaining_accounts(vault, vault_ata));
        accounts
    }

    /// Accounts shared by both create_intent variants: portal + programs + remaining.
    fn portal_and_remaining_accounts(
        &self,
        vault: Pubkey,
        vault_ata: Pubkey,
    ) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(portal::ID, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(spl_token::ID, false),
            AccountMeta::new_readonly(anchor_spl::token_2022::ID, false),
            AccountMeta::new_readonly(anchor_spl::associated_token::ID, false),
            AccountMeta::new_readonly(system_program::ID, false),
            // remaining_accounts: [from_ata, vault_ata, mint]
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

fn keccak256(data: &[u8]) -> Bytes32 {
    let mut hasher = Keccak::v256();
    let mut hash = [0u8; 32];
    hasher.update(data);
    hasher.finalize(&mut hash);
    hash.into()
}

pub fn is_anchor_error(result: &Box<FailedTransactionMetadata>) -> bool {
    matches!(
        result.err,
        TransactionError::InstructionError(_, InstructionError::Custom(_))
    )
}

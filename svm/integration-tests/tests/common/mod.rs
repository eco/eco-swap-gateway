use anchor_lang::AnchorSerialize;
use anchor_spl::associated_token::{
    get_associated_token_address,
    spl_associated_token_account::instruction::create_associated_token_account,
};
use anchor_spl::token::spl_token;
use eco_svm_std::Bytes32;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use portal::state::vault_pda;
use portal::types::{intent_hash as compute_intent_hash, Reward, TokenAmount};
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::Message;
use solana_sdk::program_pack::Pack;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::system_program;
use solana_sdk::transaction::Transaction;

use eco_swap_gateway::types::{Bucket, CloseAndSelectArgs};

const COMPUTE_UNIT_LIMIT: u32 = 400_000;
const PORTAL_BIN: &[u8] = include_bytes!("../../fixtures/portal.so");
const GATEWAY_BIN: &[u8] = include_bytes!("../../../target/deploy/eco_swap_gateway.so");

pub type TxResult = std::result::Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

pub struct Context {
    pub svm: LiteSVM,
    pub user: Keypair,
    pub sweep_recipient: Keypair,
    pub mint_authority: Keypair,
    pub mint: Pubkey,
    pub prover: Pubkey,
}

impl Context {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(portal::ID, PORTAL_BIN);
        svm.add_program(eco_swap_gateway::ID, GATEWAY_BIN);

        let user = Keypair::new();
        let sweep_recipient = Keypair::new();
        let mint_authority = Keypair::new();

        svm.airdrop(&user.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&sweep_recipient.pubkey(), 1_000_000_000).unwrap();
        svm.airdrop(&mint_authority.pubkey(), 10_000_000_000).unwrap();

        // Mint + two ATAs.
        let mint = Keypair::new();
        let mint_pk = mint.pubkey();
        let rent = svm.get_sysvar::<Rent>();
        let create_mint = solana_sdk::system_instruction::create_account(
            &mint_authority.pubkey(),
            &mint_pk,
            rent.minimum_balance(spl_token::state::Mint::LEN),
            spl_token::state::Mint::LEN as u64,
            &spl_token::ID,
        );
        let init_mint = spl_token::instruction::initialize_mint(
            &spl_token::ID,
            &mint_pk,
            &mint_authority.pubkey(),
            None,
            6,
        )
        .unwrap();
        let create_user_ata = create_associated_token_account(
            &mint_authority.pubkey(),
            &user.pubkey(),
            &mint_pk,
            &spl_token::ID,
        );
        let create_sweep_ata = create_associated_token_account(
            &mint_authority.pubkey(),
            &sweep_recipient.pubkey(),
            &mint_pk,
            &spl_token::ID,
        );
        let tx = Transaction::new(
            &[&mint_authority, &mint],
            Message::new(
                &[create_mint, init_mint, create_user_ata, create_sweep_ata],
                Some(&mint_authority.pubkey()),
            ),
            svm.latest_blockhash(),
        );
        svm.send_transaction(tx).unwrap();

        Self {
            svm,
            user,
            sweep_recipient,
            mint_authority,
            mint: mint_pk,
            prover: Keypair::new().pubkey(),
        }
    }

    // ── Core getters ─────────────────────────────────────────────────

    pub fn user_ata(&self) -> Pubkey {
        get_associated_token_address(&self.user.pubkey(), &self.mint)
    }

    pub fn sweep_recipient_token_account(&self) -> Pubkey {
        get_associated_token_address(&self.sweep_recipient.pubkey(), &self.mint)
    }

    pub fn snapshot_pda(&self) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"snap", self.user_ata().as_ref()],
            &eco_swap_gateway::ID,
        )
    }

    pub fn token_balance(&self, ata: &Pubkey) -> u64 {
        self.svm
            .get_account(ata)
            .and_then(|a| spl_token::state::Account::unpack(&a.data).ok())
            .map(|a| a.amount)
            .unwrap_or(0)
    }

    pub fn account_exists(&self, pk: &Pubkey) -> bool {
        self.svm.get_account(pk).map(|a| a.lamports > 0).unwrap_or(false)
    }

    // ── Mint / swap simulation ───────────────────────────────────────

    pub fn mint_to_user(&mut self, amount: u64) {
        let ix = spl_token::instruction::mint_to(
            &spl_token::ID,
            &self.mint,
            &self.user_ata(),
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

    // ── Buckets / vault helpers ──────────────────────────────────────

    /// Deterministic test route_hash; Portal::fund never checks on-chain
    /// whether it corresponds to a `publish` — it only checks that
    /// `vault == pda([VAULT_SEED, intent_hash(destination, route_hash, reward_hash)])`.
    pub fn route_hash_for(idx: usize) -> Bytes32 {
        let mut bytes = [0u8; 32];
        bytes[0] = 0xA5;
        bytes[31] = idx as u8;
        bytes.into()
    }

    /// Build a test reward template aligned with our base-reward invariants.
    pub fn base_reward(&self, deadline: u64) -> Reward {
        Reward {
            deadline,
            creator: self.user.pubkey(),
            prover: self.prover,
            native_amount: 0,
            tokens: vec![TokenAmount {
                token: self.mint,
                amount: 0,
            }],
        }
    }

    pub fn reward_for_bucket(&self, base: &Reward, amount: u64) -> Reward {
        let mut r = base.clone();
        assert_eq!(
            r.tokens.len(),
            1,
            "base reward must have exactly one token (enforced on-chain by validate_base_reward)"
        );
        r.tokens[0].amount = amount;
        r
    }

    pub fn vault_accounts_for_bucket(
        &self,
        destination: u64,
        bucket: &Bucket,
        base_reward: &Reward,
    ) -> (Bytes32, Pubkey, Pubkey) {
        let reward_k = self.reward_for_bucket(base_reward, bucket.reward_amount);
        let ih = compute_intent_hash(destination, &bucket.route_hash, &reward_k.hash());
        let (vpda, _) = vault_pda(&ih);
        let vata = get_associated_token_address(&vpda, &self.mint);
        (ih, vpda, vata)
    }

    // ── Instructions ─────────────────────────────────────────────────

    pub fn open_ix(&self) -> Instruction {
        let (snapshot, _) = self.snapshot_pda();
        let data = anchor_discriminator("open");
        Instruction::new_with_bytes(
            eco_swap_gateway::ID,
            &data,
            vec![
                AccountMeta::new(self.user.pubkey(), true),
                AccountMeta::new_readonly(self.user_ata(), false),
                AccountMeta::new(snapshot, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )
    }

    pub fn close_and_select_ix(
        &self,
        args: CloseAndSelectArgs,
        vault_accounts: &[(Pubkey, Pubkey)],
    ) -> Instruction {
        let (snapshot, _) = self.snapshot_pda();
        let mut data = anchor_discriminator("close_and_select_intent");
        data.extend_from_slice(&args.try_to_vec().unwrap());

        let mut metas = vec![
            AccountMeta::new(self.user.pubkey(), true),
            AccountMeta::new(self.user_ata(), false),
            AccountMeta::new(snapshot, false),
            AccountMeta::new(self.sweep_recipient_token_account(), false),
            AccountMeta::new_readonly(self.mint, false),
            AccountMeta::new_readonly(spl_token::ID, false),
            AccountMeta::new_readonly(anchor_spl::token_2022::ID, false),
            AccountMeta::new_readonly(anchor_spl::associated_token::ID, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ];
        for (vpda, vata) in vault_accounts {
            metas.push(AccountMeta::new(*vpda, false));
            metas.push(AccountMeta::new(*vata, false));
        }

        Instruction::new_with_bytes(eco_swap_gateway::ID, &data, metas)
    }

    // ── Send helpers ─────────────────────────────────────────────────

    pub fn send_as_user(&mut self, ixs: &[Instruction]) -> TxResult {
        let mut all_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(
            COMPUTE_UNIT_LIMIT,
        )];
        all_ixs.extend_from_slice(ixs);
        let tx = Transaction::new(
            &[&self.user],
            Message::new(&all_ixs, Some(&self.user.pubkey())),
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).map_err(Box::new)
    }

    pub fn unix_now(&self) -> u64 {
        self.svm.get_sysvar::<solana_sdk::clock::Clock>().unix_timestamp as u64
    }
}

pub fn anchor_discriminator(ix_name: &str) -> Vec<u8> {
    let pre = format!("global:{}", ix_name);
    let hash = solana_sdk::hash::hash(pre.as_bytes()).to_bytes();
    hash[..8].to_vec()
}

/// Anchor event discriminator: `sha256("event:<Name>")[..8]`.
pub fn anchor_event_discriminator(event_name: &str) -> [u8; 8] {
    let pre = format!("event:{}", event_name);
    let hash = solana_sdk::hash::hash(pre.as_bytes()).to_bytes();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// Decode an Anchor event of type `E` from tx logs, returning the first match.
/// Returns `None` if no `Program data:` line with `event_name`'s discriminator
/// is present, or if the payload fails to borsh-deserialize as `E`.
pub fn decode_first_event<E: anchor_lang::AnchorDeserialize>(
    logs: &[String],
    event_name: &str,
) -> Option<E> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let disc = anchor_event_discriminator(event_name);
    logs.iter().find_map(|l| {
        let b64 = l.strip_prefix("Program data: ")?;
        let bytes = STANDARD.decode(b64).ok()?;
        let payload = bytes.strip_prefix(&disc[..])?;
        E::try_from_slice(payload).ok()
    })
}

/// Returns true if `logs` show a CPI into `program_id` — i.e. a line like
/// `Program <id> invoke [N]`. Use to assert either that a dependency WAS
/// called, or (with `!`) that a branch that would invoke it was skipped.
pub fn logs_show_invoke_of(logs: &[String], program_id: &Pubkey) -> bool {
    let needle = format!("Program {} invoke", program_id);
    logs.iter().any(|l| l.starts_with(&needle))
}

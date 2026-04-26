use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    Admin,
    Vesting(Address),
    Claims(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingCreatedEvent {
    pub beneficiary: Address,
    pub total_amount: i128,
    pub start_time: u64,
    pub cliff_time: u64,
    pub end_time: u64,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PartialClaimEvent {
    pub beneficiary: Address,
    pub amount: i128,
    pub timestamp: u64,
    pub total_claimed: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub total_amount: i128,
    pub start_time: u64,
    pub cliff_time: u64,
    pub end_time: u64,
    pub claimed: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PartialClaim {
    pub amount: i128,
    pub timestamp: u64,
    pub total_claimed: i128,
}

#[contract]
pub struct VestingContract;

#[contractimpl]
impl VestingContract {
    /// Initializes the vesting contract admin.
    pub fn initialize(env: Env, admin: Address) {
        env.storage().instance().set(&StorageKey::Admin, &admin);
    }

    /// Creates a vesting schedule for a beneficiary.
    pub fn create_vesting(
        env: Env,
        beneficiary: Address,
        total_amount: i128,
        start_time: u64,
        cliff_time: u64,
        end_time: u64,
    ) {
        assert!(total_amount > 0, "Total amount must be positive");
        assert!(
            start_time <= cliff_time && cliff_time <= end_time,
            "Invalid vesting times"
        );

        let admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("Contract admin not initialized");
        admin.require_auth();

        let schedule_key = StorageKey::Vesting(beneficiary.clone());
        let claims_key = StorageKey::Claims(beneficiary.clone());
        let existing_schedule: Option<VestingSchedule> =
            env.storage().persistent().get(&schedule_key);
        let existing_claims: Option<Vec<PartialClaim>> =
            env.storage().persistent().get(&claims_key);
        assert!(
            existing_schedule.is_none(),
            "Vesting schedule already exists"
        );
        assert!(existing_claims.is_none(), "Claim ledger already exists");

        let schedule = VestingSchedule {
            total_amount,
            start_time,
            cliff_time,
            end_time,
            claimed: 0,
        };

        env.storage().persistent().set(&schedule_key, &schedule);

        let event = VestingCreatedEvent {
            beneficiary: beneficiary.clone(),
            total_amount,
            start_time,
            cliff_time,
            end_time,
            timestamp: env.ledger().timestamp(),
        };
        env.events()
            .publish(("vesting", symbol_short!("created")), event);
    }

    /// Claims vested tokens for a beneficiary.
    pub fn claim(env: Env, beneficiary: Address, amount: i128) {
        beneficiary.require_auth();

        assert!(amount > 0, "Claim amount must be positive");

        let schedule_key = StorageKey::Vesting(beneficiary.clone());
        let claims_key = StorageKey::Claims(beneficiary.clone());

        let mut schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&schedule_key)
            .expect("Vesting schedule not found");
        assert!(
            schedule.total_amount > 0,
            "Vesting schedule total amount is invalid"
        );
        assert!(schedule.claimed >= 0, "Claim cursor cannot be negative");
        assert!(
            schedule.claimed <= schedule.total_amount,
            "Claim cursor exceeds total vesting amount"
        );

        let current_time = env.ledger().timestamp();
        let vested = Self::calculate_vested(&schedule, current_time);

        let mut claims: Vec<PartialClaim> = match env.storage().persistent().get(&claims_key) {
            Some(claims) => claims,
            None => Vec::new(&env),
        };

        if claims.len() > 0 {
            let last_claim = claims
                .get(claims.len() - 1)
                .expect("Claim ledger is missing its last entry");
            assert!(
                last_claim.total_claimed == schedule.claimed,
                "Claim ledger and schedule cursor are inconsistent"
            );
        }

        let next_total_claimed = schedule
            .claimed
            .checked_add(amount)
            .expect("Claim amount overflowed the schedule cursor");
        assert!(
            vested >= next_total_claimed,
            "Claim amount exceeds vested amount"
        );
        schedule.claimed = next_total_claimed;

        let claim = PartialClaim {
            amount,
            timestamp: current_time,
            total_claimed: next_total_claimed,
        };

        claims.push_back(claim);

        env.storage().persistent().set(&claims_key, &claims);
        env.storage().persistent().set(&schedule_key, &schedule);

        let event = PartialClaimEvent {
            beneficiary: beneficiary.clone(),
            amount,
            timestamp: current_time,
            total_claimed: schedule.claimed,
        };
        env.events()
            .publish(("vesting", symbol_short!("claimed")), event);

        assert!(
            Self::sum_claims(&claims) == schedule.claimed,
            "Claim ledger does not match schedule cursor"
        );
    }

    fn sum_claims(claims: &Vec<PartialClaim>) -> i128 {
        let mut total = 0i128;
        let len = claims.len();

        let mut i: u32 = 0;
        while i < len {
            let claim = claims.get(i).expect("Claim ledger entry missing");
            total = total
                .checked_add(claim.amount)
                .expect("Claim ledger overflowed while reconciling");
            i += 1;
        }

        total
    }

    pub(crate) fn calculate_vested(schedule: &VestingSchedule, current_time: u64) -> i128 {
        if current_time < schedule.cliff_time {
            0
        } else if schedule.cliff_time == schedule.end_time {
            schedule.total_amount
        } else if current_time >= schedule.end_time {
            schedule.total_amount
        } else {
            let elapsed = current_time - schedule.cliff_time;
            let vesting_duration = schedule.end_time - schedule.cliff_time;
            let vested_numerator = schedule
                .total_amount
                .checked_mul(elapsed as i128)
                .expect("Vested amount calculation overflowed");
            vested_numerator / vesting_duration as i128
        }
    }
}

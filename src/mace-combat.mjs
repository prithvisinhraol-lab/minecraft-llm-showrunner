const WIND_CHARGE_MIN_RANGE = 2.2;
const WIND_CHARGE_MAX_RANGE = 12;
const WIND_CHARGE_COOLDOWN_MS = 1600;
const MACE_BOOST_WINDOW_MS = 1900;
const MACE_BOOST_ATTACK_DELAY_MS = 250;
const MACE_BOOST_ATTACK_RANGE = 5.2;

export function shouldUseWindCharge({
  distance,
  now,
  lastWindChargeAt,
  mainHandName,
  offHandName,
  inventoryWindCharges
}) {
  if (mainHandName !== 'mace') return false;
  if (offHandName !== 'wind_charge' && inventoryWindCharges <= 0) return false;
  if (distance < WIND_CHARGE_MIN_RANGE || distance > WIND_CHARGE_MAX_RANGE) return false;

  return now - lastWindChargeAt >= WIND_CHARGE_COOLDOWN_MS;
}

export function shouldRaiseShieldForSparring(mainHandName) {
  return mainHandName !== 'mace';
}

export function isMaceBoostActive({ now, lastWindChargeAt }) {
  return lastWindChargeAt > 0 && now - lastWindChargeAt <= MACE_BOOST_WINDOW_MS;
}

export function shouldMaceAttackDuringBoost({
  distance,
  now,
  lastWindChargeAt,
  lastAttackAt
}) {
  if (!isMaceBoostActive({ now, lastWindChargeAt })) return false;
  if (now - lastWindChargeAt < MACE_BOOST_ATTACK_DELAY_MS) return false;
  if (distance > MACE_BOOST_ATTACK_RANGE) return false;

  return now - lastAttackAt > 650;
}

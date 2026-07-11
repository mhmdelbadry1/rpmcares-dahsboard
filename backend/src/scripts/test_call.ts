import twilio from 'twilio';
import { env } from '../env';

async function main() {
  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

  console.log('From:', env.TWILIO_FROM_NUMBER);

  // 1. Check account
  console.log('\nChecking account...');
  try {
    const account = await client.api.accounts(env.TWILIO_ACCOUNT_SID!).fetch();
    console.log('✅ Account status:', account.status, '| type:', account.type);
  } catch (err: any) {
    console.error('❌ Account:', err.message);
  }

  // 2. Check number capabilities
  console.log('\nChecking phone number...');
  try {
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: env.TWILIO_FROM_NUMBER });
    if (numbers.length > 0) {
      const n = numbers[0];
      console.log('✅ Number:', n.phoneNumber, '| voice:', n.capabilities.voice, '| sms:', n.capabilities.sms);
    } else {
      console.log('⚠️  Number not in account');
    }
  } catch (err: any) {
    console.error('❌ Number check:', err.message);
  }

  // 3. Place real outbound call
  console.log('\nPlacing call to +201550566474...');
  try {
    const call = await client.calls.create({
      to: '+201550566474',
      from: env.TWILIO_FROM_NUMBER!,
      twiml: '<Response><Say voice="alice">Hello, this is a test call from RPMCares. Your communications system is working.</Say></Response>',
    });
    console.log('✅ Call SID:', call.sid, '| status:', call.status);
  } catch (err: any) {
    console.error('❌ Call failed:', err.message);
    if (err.code)     console.error('   Code:', err.code);
    if (err.moreInfo) console.error('   Info:', err.moreInfo);
  }
}

main().catch(console.error);

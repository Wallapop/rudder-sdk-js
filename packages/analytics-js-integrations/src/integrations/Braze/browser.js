/* eslint-disable class-methods-use-this */
import { equals } from 'ramda';
import { NAME, DISPLAY_NAME } from './constants';
import { StorageFactory } from '@rudderstack/analytics-js-legacy-utilities/storage';
import { stringifyWithoutCircularV1 } from '@rudderstack/analytics-js-legacy-utilities/ObjectUtils';
import Logger from '../../utils/logger';
import { isObject } from '../../utils/utils';
import { isNotEmpty } from '../../utils/commonUtils';
import { handlePurchase, formatGender, handleReservedProperties } from './utils';
import { loadNativeSdk } from './nativeSdkLoader';

const logger = new Logger(DISPLAY_NAME);

/*
E-commerce support required for logPurchase support & other e-commerce events as track with productId changed
*/
class Braze {
  constructor(config, analytics, destinationInfo) {
    if (analytics.logLevel) {
      logger.setLogLevel(analytics.logLevel);
    }
    this.analytics = analytics;
    this.appIdentifierKey = config.appKey;
    this.usePlatformSpecificApiKeys = config.usePlatformSpecificApiKeys === true;
    this.trackAnonymousUser = config.trackAnonymousUser;
    this.enableBrazeLogging = config.enableBrazeLogging || false;
    this.allowUserSuppliedJavascript = config.allowUserSuppliedJavascript || false;
    this.enablePushNotification = config.enablePushNotification || false;
    this.whitelistedEvents = config.whitelistedEvents || [];
    if (!config.appKey) this.appIdentifierKey = '';
    if (this.usePlatformSpecificApiKeys) {
      if (config.webApiKey && typeof config.webApiKey === 'string') {
        this.appIdentifierKey = config.webApiKey;
      } else {
        logger.warn(
          `Configured to use platform-specific app identifier key but the web app identifier key (${config.webApiKey}) is not valid. Using the default app identifier key instead.`,
        );
      }
    }
    this.endPoint = '';
    this.isHybridModeEnabled = config.connectionMode === 'hybrid';
    this.isReadyStatus = {
      hasLoggedErrorForAlias: false,
    };
    this.sdkMetadataAdded = false;

    if (config.dataCenter) {
      // ref: https://www.braze.com/docs/user_guide/administrative/access_braze/braze_instances
      const [dataCenterRegion, dataCenterNumber] = config.dataCenter
        .trim()
        .toLowerCase()
        .split('-');

      switch (dataCenterRegion) {
        case 'eu':
          this.endPoint = `sdk.fra-${dataCenterNumber}.braze.eu`;
          break;
        case 'us':
          this.endPoint = `sdk.iad-${dataCenterNumber}.braze.com`;
          break;
        case 'au':
          this.endPoint = `sdk.au-${dataCenterNumber}.braze.com`;
          break;
        default:
          this.endPoint = `sdk.iad-${dataCenterNumber}.braze.com`;
          break;
      }
    }

    this.name = NAME;
    this.supportDedup = config.supportDedup || false;
    // Use localStorage for dedup storage (cookie-first default does not respect SDK storage config)
    this.dedupStorage = new StorageFactory('localStorage');
    // Transform whitelistedUserTraits from array of objects [{trait: "name"}] to array of strings
    // undefined/null means no filtering (send all), empty array means send nothing
    this.whitelistedUserTraits = Array.isArray(config.whitelistedUserTraits)
      ? config.whitelistedUserTraits.map(item => item.trait)
      : undefined;
    ({
      shouldApplyDeviceModeTransformation: this.shouldApplyDeviceModeTransformation,
      propagateEventsUntransformedOnError: this.propagateEventsUntransformedOnError,
      destinationId: this.destinationId,
    } = destinationInfo ?? {});
  }

  logAliasError(message) {
    if (!this.isReadyStatus.hasLoggedErrorForAlias) {
      logger.error(message);
      this.isReadyStatus.hasLoggedErrorForAlias = true;
    }
  }

  addSdkMetadata() {
    try {
      globalThis.braze.addSdkMetadata([globalThis.braze.BrazeSdkMetadata.CDN]);
      this.sdkMetadataAdded = true;
      logger.debug('Successfully added Braze SDK metadata');
    } catch (error) {
      logger.error('Failed to add SDK metadata:', error);
    }
  }

  init() {
    const userId = this.analytics.getUserId();
    loadNativeSdk({ delay: userId ? 0 : 5_000 });
    globalThis.braze.initialize(this.appIdentifierKey, {
      enableLogging: this.enableBrazeLogging,
      baseUrl: this.endPoint,
      allowUserSuppliedJavascript: this.allowUserSuppliedJavascript,
    });

    globalThis.braze.automaticallyShowInAppMessages();
    if (this.enablePushNotification) {
      globalThis.braze.requestPushPermission();
    }
  }

  isLoaded() {
    return globalThis.brazeQueue === null;
  }

  setUserAlias() {
    try {
      const user = globalThis.braze.getUser();
      if (!user) {
        this.logAliasError('Braze user object is not available');
        return;
      }

      const anonymousId = this.analytics.getAnonymousId();
      if (!anonymousId) {
        this.logAliasError('Anonymous ID is not available');
        return;
      }
      user.addAlias(anonymousId, 'rudder_id');

      // Immediately flush the alias to prevent race conditions with cloud mode events
      try {
        if (globalThis.braze && typeof globalThis.braze.requestImmediateDataFlush === 'function') {
          globalThis.braze.requestImmediateDataFlush();
        }
      } catch (flushError) {
        logger.warn('Failed to flush Braze alias immediately:', flushError);
      }
    } catch (error) {
      this.logAliasError(`Error setting alias: ${stringifyWithoutCircularV1(error, true)}`);
    }
  }

  isReady() {
    if (!this.isLoaded()) {
      return false;
    }

    // Add SDK metadata when the integration becomes ready (only once)
    if (!this.sdkMetadataAdded) {
      this.addSdkMetadata();
    }

    return true;
  }

  /**
   * As each users will have unique session, So if the supportDedup is enabled from config,
   * then we are comparing from the previous payload and tried to reduce the redundant data.
   * If supportDedup is enabled,
   * Examples:
   * - If userId is different from previous call, then it will make new call and store the payload.
   * - It will deeply check all other attributes and pass the unique or changed fields.
   *   1st- payload                                                                                     2nd- payload
   * rudderanalytics.identify("rudderUserId100", {                                                   rudderanalytics.identify("rudderUserId100", {
   *  name: "Rudder Keener",                                                                          name: "Rudder Keener",
   *  email: "rudder100@example.com",                                                                 email: "rudder100@example.com",
   *  primaryEmail: "test350@email.com",                                                              primaryEmail: "test350@email.com",
   *  country: "USA",                                                                                 country: "USA",
   *  subscription: "youtube-prime-6",                                                                subscription: "youtube-prime-6",
   *  channelName: ["b", "d", "e", "f"],                                                              channelName: ["b", "d", "e", "f"],
   *  gender: "male",                                                                                 gender: "male",
   *  facebook: "https://www.facebook.com/rudder.123",                                                facebook: "https://www.facebook.com/rudder.345",
   *  birthday: new Date("2000-10-23"),                                                               birthday: new Date("2000-10-24"),
   *  firstname: "Rudder",                                                                            firstname: "Rudder",
   *  lastname: "Keener",                                                                             lastname: "Usertest",
   *  phone: "9112345631",                                                                            phone: "9112345631",
   *  key1: "value4",                                                                                 key1: "value5",
   *  address: {                                                                                      address: {
   *   city: "Manali",                                                                                 city: "Shimla",
   *   country: "India",                                                                               country: "India",
   *  },                                                                                              },
   * });                                                                                             });
   * As both payload have same userId so it will deeply check all other attributes and pass the unique fields
   * or the updated fields.
   * @param {*} rudderElement
   */
  // eslint-disable-next-line sonarjs/cognitive-complexity
  identify(rudderElement) {
    const { message } = rudderElement;
    const { userId } = message;

    if (this.isHybridModeEnabled) {
      if (userId) {
        globalThis.braze.changeUser(userId);
        this.setUserAlias();
      }
      return;
    }

    const { context } = message;
    const email = context?.traits?.email;
    const firstName = context?.traits?.firstName || context?.traits?.firstname;
    const lastName = context?.traits?.lastName || context?.traits?.lastname;
    const gender = context?.traits?.gender;
    const phone = context?.traits?.phone;
    const address = context?.traits?.address;
    const birthday = context?.traits?.birthday || context?.traits?.dob;
    const reserved = [
      'address',
      'birthday',
      'email',
      'id',
      'firstname',
      'firstName',
      'gender',
      'lastname',
      'lastName',
      'phone',
      'dob',
      'birthday',
      'external_id',
      'country',
      'home_city',
      'email_subscribe',
      'push_subscribe',
    ];
    // function set Address
    function setAddress() {
      globalThis.braze.getUser().setCountry(address?.country);
      globalThis.braze.getUser().setHomeCity(address?.city);
    }
    // function set Birthday
    function setBirthday() {
      try {
        const date = new Date(birthday);
        if (date.toString() === 'Invalid Date') {
          logger.error('Invalid Date for birthday');
          return;
        }
        globalThis.braze
          .getUser()
          .setDateOfBirth(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
      } catch (error) {
        logger.error(`Error in setting birthday - ${stringifyWithoutCircularV1(error, true)}`);
      }
    }
    // function set Email
    function setEmail() {
      globalThis.braze.getUser().setEmail(email);
    }
    // function set firstName
    function setFirstName() {
      globalThis.braze.getUser().setFirstName(firstName);
    }
    // function set gender
    function setGender(genderName) {
      globalThis.braze.getUser().setGender(genderName);
    }
    // function set lastName
    function setLastName() {
      globalThis.braze.getUser().setLastName(lastName);
    }
    function setPhone() {
      globalThis.braze.getUser().setPhoneNumber(phone);
    }

    // eslint-disable-next-line unicorn/consistent-destructuring
    const traits = message?.context?.traits;

    const previousPayload = this.dedupStorage.getItem('rs_braze_dedup_attributes') || {};
    if (this.supportDedup && isNotEmpty(previousPayload) && userId === previousPayload?.userId) {
      if (userId) {
        globalThis.braze.changeUser(userId);
        this.setUserAlias();
      }
      const prevTraits = previousPayload?.context?.traits;
      const prevAddress = prevTraits?.address;
      const prevBirthday = prevTraits?.birthday || prevTraits?.dob;
      const prevEmail = prevTraits?.email;
      const prevFirstname = prevTraits?.firstname || prevTraits?.firstName;
      const prevGender = prevTraits?.gender;
      const prevLastname = prevTraits?.lastname || prevTraits?.lastName;
      const prevPhone = prevTraits?.phone;

      if (email && email !== prevEmail) setEmail();
      if (phone && phone !== prevPhone) setPhone();
      if (birthday && !equals(birthday, prevBirthday)) setBirthday();
      if (firstName && firstName !== prevFirstname) setFirstName();
      if (lastName && lastName !== prevLastname) setLastName();
      if (gender && formatGender(gender) !== formatGender(prevGender))
        setGender(formatGender(gender));
      if (address && !equals(address, prevAddress)) setAddress();
      if (isObject(traits)) {
        Object.keys(traits)
          .filter(key => {
            // More context in WPA-101961
            // Exclude standard reserved traits
            if (reserved.indexOf(key) > -1) return false;
            // If whitelist is undefined, send all traits
            if (this.whitelistedUserTraits === undefined) return true;
            // If whitelist is empty array, send no traits
            if (this.whitelistedUserTraits.length === 0) return false;
            // If whitelist has items, only send whitelisted traits
            return this.whitelistedUserTraits.includes(key);
          })
          .forEach(key => {
            if (!prevTraits[key] || !equals(prevTraits[key], traits[key])) {
              globalThis.braze.getUser().setCustomUserAttribute(key, traits[key]);
            }
          });
      }
    } else {
      // Guard: skip changeUser with empty string to prevent ghost profiles
      if (userId) {
        globalThis.braze.changeUser(userId);
        this.setUserAlias();
      }
      // method removed from v4 https://www.braze.com/docs/api/objects_filters/user_attributes_object#braze-user-profile-fields
      // globalThis.braze.getUser().setAvatarImageUrl(avatar);
      if (email) setEmail();
      if (firstName) setFirstName();
      if (lastName) setLastName();
      if (gender) setGender(formatGender(gender));
      if (phone) setPhone();
      if (address) setAddress();
      if (birthday) setBirthday();

      if (isObject(traits)) {
        Object.keys(traits)
          .filter(key => {
            // Exclude standard reserved traits
            if (reserved.indexOf(key) > -1) return false;
            // If whitelist is undefined, send all traits
            if (this.whitelistedUserTraits === undefined) return true;
            // If whitelist is empty array, send no traits
            if (this.whitelistedUserTraits.length === 0) return false;
            // If whitelist has items, only send whitelisted traits
            return this.whitelistedUserTraits.includes(key);
          })
          .forEach(key => {
            globalThis.braze.getUser().setCustomUserAttribute(key, traits[key]);
          });
      }
    }
    globalThis.braze.openSession();
    if (
      this.supportDedup &&
      isObject(previousPayload) &&
      isNotEmpty(previousPayload) &&
      userId === previousPayload?.userId
    ) {
      this.dedupStorage.setItem('rs_braze_dedup_attributes', { ...previousPayload, ...message });
    } else if (this.supportDedup) {
      this.dedupStorage.setItem('rs_braze_dedup_attributes', message);
    }
  }

  track(rudderElement) {
    if (this.isHybridModeEnabled) {
      return;
    }
    const eventName = rudderElement.message.event;
    let { properties } = rudderElement.message;

    const { userId } = rudderElement.message;
    let canSendCustomEvent = false;
    if (userId || this.trackAnonymousUser) {
      canSendCustomEvent = true;
    }
    if (eventName && canSendCustomEvent) {
      if (eventName.toLowerCase() === 'order completed') {
        handlePurchase(properties);
      } else {
        properties = handleReservedProperties(properties);
        globalThis.braze.logCustomEvent(eventName, properties);
      }
    }
  }

  page(rudderElement) {
    if (this.isHybridModeEnabled) {
      return;
    }
    const eventName = rudderElement.message.name;
    let { properties } = rudderElement.message;

    // In the whitelistedEvents we also have page events. This code filters out the ones not set there.
    // More context in WPA-101959
    if (this.whitelistedEvents.length > 0) {
      const whitelistedEventNames = this.whitelistedEvents.map(e => e.eventName);
      const eventToCheck = eventName || 'Page View';
      if (!whitelistedEventNames.includes(eventToCheck)) {
        logger.debug(`Event "${eventToCheck}" is not in the whitelist. Skipping.`);
        return;
      }
    }

    properties = handleReservedProperties(properties);
    if (eventName) {
      globalThis.braze.logCustomEvent(eventName, properties);
    } else {
      globalThis.braze.logCustomEvent('Page View', properties);
    }
  }
}

export default Braze;


import {
  NativeModules,
  PushNotificationIOS,
  AppState,
} from 'react-native';

import IdleTimerManager from 'react-native-idle-timer';

import NotificationsIOS, { NotificationAction, NotificationCategory } from 'react-native-notifications';

import Sound from 'react-native-sound';

import SilentSwitch from 'react-native-silent-switch';

import OneSignal from 'react-native-onesignal';
import { loadSoundPromise } from '../utilities';

import {
  updateNotificationPermissions,
  updateSilentSwitchState,
  updatePushNotificationID,
  NOTIFICATION_PERMISSIONS_STATUS_AUTHORIZED,
  NOTIFICATION_PERMISSIONS_STATUS_NOTDETERMINED,
} from '../actions/notifications';

import { soundAlarm, snoozeAlarm, stopAlarm } from '../actions/alarm';

import TimeWatcherActor from './timeWatcher';

export default class NotificationActor {
  constructor(store) {
    this.store = store;
    this.dispatch = store.dispatch;
    this.timeWatcherActor = null;
    this.silent = false;
    this.permissions = NOTIFICATION_PERMISSIONS_STATUS_NOTDETERMINED;

    // Everytime app is opened, check if notifications are still on
    AppState.addEventListener('change', () => {
      this.checkStatus();
    });

    // Listen for silent switch toggle events
    SilentSwitch.addEventListener((silent) => {
      this.silent = silent;
      if (AppState.currentState === 'active') {
        if (silent || this.permissions !== NOTIFICATION_PERMISSIONS_STATUS_AUTHORIZED) {
          // console.log('timer is off')
          // console.log('screen will not dim')
          // console.log('setting idle timer disabled to true, notifications.ios.js line 49');
          IdleTimerManager.setIdleTimerDisabled(true);
        } else {
          // console.log('timer is on');
          // console.log('screen will dim');
          // console.log('setting idle timer disabled to false, notifications.ios.js line 43');
          IdleTimerManager.setIdleTimerDisabled(false);
        }
        this.dispatch(updateSilentSwitchState(silent));
      }
    });

    // Push Notifications Configure
    OneSignal.addEventListener('ids', this.onIds.bind(this));
    OneSignal.addEventListener('received', this.onPushNotificationReceived.bind(this));
    OneSignal.configure();

    // Local Notifications Configure
    NotificationsIOS.addEventListener('notificationReceivedForeground', this.onNotificationReceivedForeground.bind(this));
    NotificationsIOS.addEventListener('notificationReceivedBackground', this.onNotificationReceivedBackground.bind(this));
    NotificationsIOS.addEventListener('notificationOpened', this.onNotificationOpened.bind(this));

    this.snoozeAction = new NotificationAction({
      activationMode: 'background',
      title: 'Snooze',
      identifier: 'SNOOZE_ACTION',
    }, (action, completed) => {
      this.dispatch(snoozeAlarm(action.notification.getData().alarmUUID));
      completed();
    });

    this.stopAction = new NotificationAction({
      activationMode: 'background',
      title: 'Stop',
      identifier: 'STOP_ACTION',
    }, (action, completed) => {
      this.dispatch(stopAlarm(action.notification.getData().alarmUUID));
      completed();
    });

    this.alarmActions = new NotificationCategory({
      identifier: 'ALARM',
      actions: [this.snoozeAction, this.stopAction],
      context: 'default',
    });

    this.requestPermissions().then(() => {
      this.checkStatus().catch(() => {
        this.checkStatus();
      });
    });

    // consume actions
    NotificationsIOS.consumeBackgroundQueue();
    // consume notifications
    PushNotificationIOS.getInitialNotification(0).then((notification) => {
      if (notification !== null) {
        this.dispatch(snoozeAlarm(notification.getData().alarmUUID));
      }
    });
  }

  killActor() {
    AppState.removeEventListener('change');
    SilentSwitch.removeEventListener();

    OneSignal.removeEventListener('ids', this.onIds.bind(this));
    OneSignal.removeEventListener('received', this.onReceived.bind(this));

    NotificationsIOS.removeEventListener('notificationReceivedForeground', this.onNotificationReceivedForeground.bind(this));
    NotificationsIOS.removeEventListener('notificationReceivedBackground', this.onNotificationReceivedForeground.bind(this));
    NotificationsIOS.removeEventListener('notificationOpened', this.onNotificationOpened.bind(this));
    NotificationsIOS.resetCategories();

    if (this.TimeWatcherActor) {
      this.TimeWatcherActor.killActor(this.silent);
    }
  }

  // Local Nofitication call backs

  onNotificationReceivedForeground(notification) {
    this.dispatch(soundAlarm(notification.getData().alarmUUID));
  }

  onNotificationReceivedBackground(notification) {
    this.dispatch(soundAlarm(notification.getData().alarmUUID));
  }

  onNotificationOpened(notification) {
    this.dispatch(soundAlarm(notification.getData().alarmUUID));
  }

  // One Signal call backs
  onIds(device) {
    updatePushNotificationID(device.userId);
  }


  onPushNotificationReceived(notification) {
    // Load the sound file 'whoosh.mp3' from the app bundle
    // See notes below about preloading sounds within initialization code below.
    console.log('playn song');
    var whoosh = new Sound('forest.wav', Sound.MAIN_BUNDLE, (error) => {
      if (error) {
        console.log('failed to load the sound', error);
        return;
      }
      // loaded successfully

      console.log('duration in seconds: ' + whoosh.getDuration() + 'number of channels: ' + whoosh.getNumberOfChannels());
        // Play the sound with an onEnd callback
         whoosh.play((success) => {
        if (success) {
          console.log('successfully finished playing');
        } else {
          console.log('playback failed due to audio decoding errors');
          // reset the player to its uninitialized state (android only)
          // this is the only option to recover after an error occured and use the player again
          whoosh.reset();
        }
      });
    });
    console.log(notification);
    console.log('yes the push was gotten');
    this.dispatch(soundAlarm(notification.payload.additionalData.p2p_notification.alarmUUID));
  }

  async checkStatus() {
    try {
      this.permissions = await NativeModules.CMSiOSNotificationPermissionsManager.checkPermissions();

      if (this.permissions !== NOTIFICATION_PERMISSIONS_STATUS_AUTHORIZED) {
        // If we cannot get push notification permissions then watch
        // the time to sound alarms
        if (this.TimeWatcherActor == null) {
          this.TimeWatcherActor = new TimeWatcherActor(this.store);
        }
      } else {
        if (this.TimeWatcherActor) {
          this.TimeWatcherActor.killActor(this.silent);
          this.TimeWatcherActor = null;
        }
      }

      this.dispatch(updateNotificationPermissions(this.permissions));
    } catch (e) {
      console.log(e);
    }
  }

  async requestPermissions() {
    try {
      NotificationsIOS.requestPermissions([this.alarmActions]);
      await NativeModules.CMSiOSNotificationPermissionsManager.requestPermissions();
    } catch (e) {
      console.log(e);
    }
  }
}

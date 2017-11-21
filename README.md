<<<<<<< HEAD
# Raspberry3pi_Diaper
As a transfer to send the senser's massage to servers.
=======
Initial Setup
=============

First Time Boot
---------------
1. Connect a keyboard to the Raspberry Pi's USB port
2. Connect the Raspberry Pi to a Monitor/TV with a HDMI cable
3. Plug in the power adapter to power on the Raspberry Pi
4. You should see the user 'pi' auto login the console after ~20s
5. If you are going to use Ethernet/POE in the field test, you can skip the
   next section and go to DiaperSens test directly. Otherwise please follow
   below instructions to give Raspberry Pi Internet access.

Wi-Fi Internet Connection
-------------------------
1. Open Wi-Fi config file in command line:
`sudo nano /etc/wpa_supplicant/wpa_supplicant.conf`
2. Replace ssid value "tiparksv" to the SSID of the field testing Wi-Fi AP
3. Replace psk value "tipark1601" to the Wi-Fi password
4. You can have multiple Wi-Fi networks configured, just duplicate the
   `network={...}` block multiple times. This is useful when you configure
   the Raspberry Pi at a different place than the testing field. You can put
   both Wi-Fi networks' ssid/psk in the file.
5. Save the file by hitting key Ctrl-X, Y, and Enter/Return
6. Reboot the Raspberry Pi in command line:  
`sudo reboot`
7. After booted, you should be able to access Internet. You can confirm with:  
`ping google.com`
8. When DiaperSens detects the RH (Relative Humidity) value exceeds the
   threshold, it can be configured to send a SMS message to one or multiple
   cell phones. Follow the next section to configure SMS receiver phones.

SMS Receiver Phone Setup
------------------------
0. Config your sensor: (e.g. the sensor's mac address is c4:34:39:d3:1d:6e)
`mkdir -p ~/ElderSens/config && touch ~/ElderSens/config/DiaperSens-c4\:34\:39\:d3\:1d\:6e.txt`
1. Open ElderSens config file in command line:
`nano ~/ElderSens/config/DiaperSens-c4\:34\:39\:d3\:1d\:6e.txt`
2. Add the SMS receiver phone's carrier and number (with a space in between).
   Below carriers are supported: AT&T, Sprint, T-Mobile and Verizon. e.g.  
> Phone: Verizon 2082720078  
> Phone: T-Mobile 4083168352  
> Phone: AT&T 4086658952  

3. Save the file by hitting key Ctrl-X, Y, and Enter/Return
4. Reboot the Raspberry Pi in command line:  
`sudo reboot`
5. The SensHub is functional after booted.


DiaperSens Test
===============
1. Hook the DiaperSens sensor onto a diaper
2. Wait for pee to trigger SMS message


Troubleshooting
===============
1. The password for Linux user `pi` is set to `eldersens`.
2. If Wi-Fi doesn't work, type `startx` in command line and connect a USB mouse
   to use the GUI to configure Wi-Fi. The Wi-Fi manager is on the upper right
   corner of the menu bar.


######The ElderSens Team, 5/7/2017
>>>>>>> resperry3

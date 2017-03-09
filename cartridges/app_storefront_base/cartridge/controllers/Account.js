'use strict';

var server = require('server');
var OrderMgr = require('dw/order/OrderMgr');
var Order = require('dw/order/Order');
var Transaction = require('dw/system/Transaction');
var CustomerMgr = require('dw/customer/CustomerMgr');
var Resource = require('dw/web/Resource');
var URLUtils = require('dw/web/URLUtils');
var Mail = require('dw/net/Mail');
var Template = require('dw/util/Template');
var Site = require('dw/system/Site');
var HashMap = require('dw/util/HashMap');

var AccountModel = require('~/cartridge/models/account');
var AddressModel = require('~/cartridge/models/address');
var OrderModel = require('~/cartridge/models/order');
var ProductLineItemsModel = require('~/cartridge/models/productLineItems');
var ShippingModels = require('~/cartridge/models/shipping');
var TotalsModel = require('~/cartridge/models/totals');

/**
 * Creates an account model for the current customer
 * @param {Object} req - local instance of request object
 * @returns {Object} a plain object of the current customer's account
 */
function getModel(req) {
    var orderModel;
    var preferredAddressModel;

    if (!req.currentCustomer.profile) {
        return null;
    }

    var customerNo = req.currentCustomer.profile.customerNo;
    var customerOrders = OrderMgr.searchOrders(
        'customerNo={0} AND status!={1}',
        'creationDate desc',
        customerNo,
        Order.ORDER_STATUS_REPLACED
	);

    var order = customerOrders.first();

    if (order) {
//        var defaultShipment = order.defaultShipment;
//        var ordershippingAdress = defaultShipment.shippingAddress;
//        var shippingAddressModel = new AddressModel(ordershippingAdress);
//        var shipmentShippingModel = ShippingMgr.getShipmentShippingModel(defaultShipment);
//        var shippingModels = new ShippingModels(
//            defaultShipment,
//            shipmentShippingModel,
//            shippingAddressModel
//        );
        var shippingModels = new ShippingModels(order);
        var productLineItemsModel = new ProductLineItemsModel(order);
        var totalsModel = new TotalsModel(order);
        var config = {
            numberOfLineItems: 'single'
        };

        var modelsObject = {
            billingModel: null,
            shippingModels: shippingModels,
            totalsModel: totalsModel,
            productLineItemsModel: productLineItemsModel
        };

        orderModel = new OrderModel(order, modelsObject, config);
    } else {
        orderModel = null;
    }

    if (req.currentCustomer.addressBook.preferredAddress) {
        preferredAddressModel = new AddressModel(req.currentCustomer.addressBook.preferredAddress);
    } else {
        preferredAddressModel = null;
    }

    return new AccountModel(req.currentCustomer, preferredAddressModel, orderModel);
}

/**
 * Checks if the email value entered is correct format
 * @param {string} email - email string to check if valid
 * @returns {boolean} Whether email is valid
 */
function validateEmail(email) {
    var regex = /^[\w.%+-]+@[\w.-]+\.[\w]{2,6}$/;
    return regex.test(email);
}

/**
 * Gets the password reset token of a customer
 * @param {Object} customer - the customer requesting password reset token
 * @returns {string} password reset token string
 */
function getPasswordResetToken(customer) {
    var passwordResetToken;
    Transaction.wrap(function () {
        passwordResetToken = customer.profile.credentials.createResetPasswordToken();
    });
    return passwordResetToken;
}

/**
 * Sends the email with password reset instructions
 * @param {string} email - email for password reset
 * @param {Object} resettingCustomer - the customer requesting password reset
 */
function sendPasswordResetEmail(email, resettingCustomer) {
    var template;
    var content;
    var passwordResetToken = getPasswordResetToken(resettingCustomer);
    var url = URLUtils.https('Account-SetNewPassword', 'token', passwordResetToken);
    var objectForEmail = {
        passwordResetToken: passwordResetToken,
        firstName: resettingCustomer.profile.firstName,
        lastName: resettingCustomer.profile.lastName,
        url: url
    };
    var resetPasswordEmail = new Mail();
    var context = new HashMap();
    Object.keys(objectForEmail).forEach(function (key) {
        context.put(key, objectForEmail[key]);
    });

    resetPasswordEmail.addTo(email);
    resetPasswordEmail.setSubject(
        Resource.msg('subject.profile.resetpassword.email', 'login', null));
    resetPasswordEmail.setFrom(Site.current.getCustomPreferenceValue('customerServiceEmail')
        || 'no-reply@salesforce.com');

    template = new Template('account/password/passwordResetEmail');
    content = template.render(context).text;
    resetPasswordEmail.setContent(content, 'text/html', 'UTF-8');
    resetPasswordEmail.send();
}

server.get('Show', server.middleware.https, function (req, res, next) {
    var accountModel = getModel(req);
    if (accountModel) {
        res.render('account/accountdashboard', {
            account: accountModel,
            accountlanding: true,
            breadcrumbs: [
                {
                    htmlValue: Resource.msg('global.home', 'common', null),
                    url: URLUtils.home().toString()
                },
                {
                    htmlValue: Resource.msg('page.title.myaccount', 'account', null)
                }
            ]
        });
    } else {
        res.redirect(URLUtils.url('Login-Show'));
    }
    next();
});

server.post('Login', server.middleware.https, function (req, res, next) {
    var email = req.form.loginEmail;
    var password = req.form.loginPassword;
    var rememberMe = req.form.loginRememberMe
        ? (!!req.form.loginRememberMe)
        : false;
    var authenticatedCustomer;
    var checkoutLogin = req.querystring.checkoutLogin;

    Transaction.wrap(function () {
        authenticatedCustomer = CustomerMgr.loginCustomer(email, password, rememberMe);
    });
    if (authenticatedCustomer && authenticatedCustomer.authenticated) {
        res.json({
            success: true,
            redirectUrl: checkoutLogin
                ? URLUtils.url('Checkout-Start').toString()
                : URLUtils.url('Account-Show').toString()
        });
    } else {
        res.json({ error: [Resource.msg('error.message.login.form', 'login', null)] });
    }
    next();
});

server.post('SubmitRegistration', server.middleware.https, function (req, res, next) {
    var formErrors = require('~/cartridge/scripts/formErrors');

    var registrationForm = server.forms.getForm('profile');

    // form validation
    if (registrationForm.customer.email.value !== registrationForm.customer.emailconfirm.value) {
        registrationForm.customer.email.valid = false;
        registrationForm.customer.emailconfirm.valid = false;
        registrationForm.customer.emailconfirm.error =
            Resource.msg('error.message.mismatch.email', 'forms', null);
        registrationForm.valid = false;
    }

    if (registrationForm.login.password.value !== registrationForm.login.passwordconfirm.value) {
        registrationForm.login.password.valid = false;
        registrationForm.login.passwordconfirm.valid = false;
        registrationForm.login.passwordconfirm.error =
            Resource.msg('error.message.mismatch.password', 'forms', null);
        registrationForm.valid = false;
    }

    // setting variables for the BeforeComplete function
    var registrationFormObj = {
        firstName: registrationForm.customer.firstname.value,
        lastName: registrationForm.customer.lastname.value,
        phone: registrationForm.customer.phone.value,
        email: registrationForm.customer.email.value,
        emailConfirm: registrationForm.customer.emailconfirm.value,
        password: registrationForm.login.password.value,
        passwordConfirm: registrationForm.login.passwordconfirm.value,
        validForm: registrationForm.valid,
        form: registrationForm
    };

    if (registrationForm.valid) {
        res.setViewData(registrationFormObj);

        this.on('route:BeforeComplete', function (req, res) { // eslint-disable-line no-shadow
            // getting variables for the BeforeComplete function
            var registrationForm = res.getViewData(); // eslint-disable-line

            if (registrationForm.validForm) {
                var login = registrationForm.email;
                var password = registrationForm.password;
                var authenticatedCustomer;

                // attempt to create a new user and log that user in.
                try {
                    Transaction.wrap(function () {
                        var newCustomer = CustomerMgr.createCustomer(login, password);

                        if (newCustomer) {
                            // assign values to the profile
                            var newCustomerProfile = newCustomer.getProfile();
                            authenticatedCustomer =
                                CustomerMgr.loginCustomer(login, password, false);
                            newCustomerProfile.firstName = registrationForm.firstName;
                            newCustomerProfile.lastName = registrationForm.lastName;
                            newCustomerProfile.phoneHome = registrationForm.phone;
                            newCustomerProfile.email = registrationForm.email;
                        }

                        if (authenticatedCustomer === undefined) {
                            registrationForm.validForm = false;
                            registrationForm.form.customer.email.valid = false;
                            registrationForm.form.customer.emailconfirm.valid = false;
                        }
                    });
                } catch (e) {
                    registrationForm.validForm = false;
                    registrationForm.form.customer.email.valid = false;
                    registrationForm.form.customer.email.error =
                        Resource.msg('error.message.username.taken', 'forms', null);
                }
            }

            if (registrationForm.validForm) {
                res.json({
                    success: true,
                    redirectUrl: URLUtils.url('Account-Show').toString()
                });
            } else {
                res.json({
                    fields: formErrors(registrationForm)
                });
            }
        });
    } else {
        res.json({
            fields: formErrors(registrationForm)
        });
    }
    next();
});

server.get('EditProfile', server.middleware.https, function (req, res, next) {
    var accountModel = getModel(req);
    if (accountModel) {
        var profileForm = server.forms.getForm('profile');
        profileForm.clear();
        profileForm.customer.firstname.value = accountModel.profile.firstName;
        profileForm.customer.lastname.value = accountModel.profile.lastName;
        profileForm.customer.phone.value = accountModel.profile.phone;
        profileForm.customer.email.value = accountModel.profile.email;
        res.render('account/profile', {
            profileForm: profileForm,
            breadcrumbs: [
                {
                    htmlValue: Resource.msg('global.home', 'common', null),
                    url: URLUtils.home().toString()
                },
                {
                    htmlValue: Resource.msg('page.title.myaccount', 'account', null),
                    url: URLUtils.url('Account-Show').toString()
                },
                {
                    htmlValue: Resource.msg('label.profile.edit', 'account', null)
                }
            ]
        });
    } else {
        res.redirect(URLUtils.url('Login-Show'));
    }
    next();
});

server.post('SaveProfile', server.middleware.https, function (req, res, next) {
    var profileForm = server.forms.getForm('profile');

    // form validation
    if (profileForm.customer.email.value !== profileForm.customer.emailconfirm.value) {
        profileForm.valid = false;
        profileForm.customer.email.valid = false;
        profileForm.customer.emailconfirm.valid = false;
        profileForm.customer.emailconfirm.error =
            Resource.msg('error.message.mismatch.email', 'forms', null);
    }

    var result = {
        firstName: profileForm.customer.firstname.value,
        lastName: profileForm.customer.lastname.value,
        phone: profileForm.customer.phone.value,
        email: profileForm.customer.email.value,
        confirmEmail: profileForm.customer.emailconfirm.value,
        password: profileForm.login.password.value,
        profileForm: profileForm
    };
    if (profileForm.valid) {
        res.setViewData(result);
        this.on('route:BeforeComplete', function (req, res) { // eslint-disable-line no-shadow
            var formInfo = res.getViewData();
            var customer = CustomerMgr.getCustomerByCustomerNumber(
                req.currentCustomer.profile.customerNo
            );
            var profile = customer.getProfile();
            var customerLogin;
            var status;
            Transaction.wrap(function () {
                status = customer.profile.credentials.setPassword(
                    formInfo.password,
                    formInfo.password,
                    true
                );
                if (!status.error) {
                    customerLogin = profile.credentials.setLogin(formInfo.email, formInfo.password);
                } else {
                    customerLogin = false;
                    formInfo.profileForm.login.password.valid = false;
                    formInfo.profileForm.login.password.error =
                        Resource.msg('error.message.currentpasswordnomatch', 'forms', null);
                }
            });
            if (customerLogin) {
                Transaction.wrap(function () {
                    profile.setFirstName(formInfo.firstName);
                    profile.setLastName(formInfo.lastName);
                    profile.setEmail(formInfo.email);
                    profile.setPhoneHome(formInfo.phone);
                });
                res.redirect(URLUtils.url('Account-Show'));
            } else {
                res.render(
                    'account/profile',
                    { profileForm: profileForm }
                );
            }
        });
    } else {
        res.render('account/profile', { profileForm: profileForm });
    }
    next();
});

server.get('EditPassword', server.middleware.https, function (req, res, next) {
    var accountModel = getModel(req);
    if (accountModel) {
        var profileForm = server.forms.getForm('profile');
        profileForm.clear();
        res.render('account/password', {
            profileForm: profileForm,
            breadcrumbs: [
                {
                    htmlValue: Resource.msg('global.home', 'common', null),
                    url: URLUtils.home().toString()
                },
                {
                    htmlValue: Resource.msg('page.title.myaccount', 'account', null),
                    url: URLUtils.url('Account-Show').toString()
                },
                {
                    htmlValue: Resource.msg('label.profile.changepassword', 'account', null)
                }
            ]
        });
    } else {
        res.redirect(URLUtils.url('Login-Show'));
    }
    next();
});

server.post('SavePassword', server.middleware.https, function (req, res, next) {
    var profileForm = server.forms.getForm('profile');
    var newPasswords = profileForm.login.newpasswords;
    // form validation
    if (newPasswords.newpassword.value !== newPasswords.newpasswordconfirm.value) {
        profileForm.valid = false;
        newPasswords.newpassword.valid = false;
        newPasswords.newpasswordconfirm.valid = false;
        newPasswords.newpasswordconfirm.error =
            Resource.msg('error.message.mismatch.newpassword', 'forms', null);
    }

    var result = {
        currentPassword: profileForm.login.currentpassword.value,
        newPassword: newPasswords.newpassword.value,
        newPasswordConfirm: newPasswords.newpasswordconfirm.value,
        profileForm: profileForm
    };

    if (profileForm.valid) {
        res.setViewData(result);
        this.on('route:BeforeComplete', function () { // eslint-disable-line no-shadow
            var formInfo = res.getViewData();
            var customer = CustomerMgr.getCustomerByCustomerNumber(
                req.currentCustomer.profile.customerNo
            );
            var status;
            Transaction.wrap(function () {
                status = customer.profile.credentials.setPassword(
                    formInfo.newPassword,
                    formInfo.currentPassword,
                    true
                );
            });
            if (status.error) {
                formInfo.profileForm.login.currentpassword.valid = false;
                formInfo.profileForm.login.currentpassword.error =
                    Resource.msg('error.message.currentpasswordnomatch', 'forms', null);
                res.render(
                    'account/password',
                    { profileForm: profileForm }
                );
            } else {
                res.redirect(URLUtils.url('Account-Show'));
            }
        });
    } else {
        res.render('account/password', { profileForm: profileForm });
    }
    next();
});

server.post('PasswordResetDialogForm', server.middleware.https, function (req, res, next) {
    var email = req.form.loginEmail;
    var errorMsg;
    var isValid;
    var resettingCustomer;
    var receivedMsgHeading = Resource.msg('label.resetpasswordreceived', 'login', null);
    var receivedMsgBody = Resource.msg('msg.requestedpasswordreset', 'login', null);
    var buttonText = Resource.msg('button.text.loginform', 'login', null);
    if (email) {
        isValid = validateEmail(email);
        if (isValid) {
            resettingCustomer = CustomerMgr.getCustomerByLogin(email);
            if (resettingCustomer) {
                sendPasswordResetEmail(email, resettingCustomer);
            }
            res.json({
                success: true,
                receivedMsgHeading: receivedMsgHeading,
                receivedMsgBody: receivedMsgBody,
                buttonText: buttonText
            });
        } else {
            errorMsg = Resource.msg('error.message.passwordreset', 'login', null);
            res.json({
                fields: {
                    loginEmail: errorMsg
                }
            });
        }
    } else {
        errorMsg = Resource.msg('error.message.required', 'login', null);
        res.json({
            fields: {
                loginEmail: errorMsg
            }
        });
    }
    next();
});

server.get('SetNewPassword', server.middleware.https, function (req, res, next) {
    var passwordForm = server.forms.getForm('newpasswords');
    passwordForm.clear();
    var token = req.querystring.token;
    var resettingCustomer = CustomerMgr.getCustomerByToken(token);
    if (!resettingCustomer) {
        res.redirect(URLUtils.url('Account-PasswordReset'));
    } else {
        res.render('account/password/newpassword', { passwordForm: passwordForm, token: token });
    }
    next();
});

server.post('SaveNewPassword', server.middleware.https, function (req, res, next) {
    var passwordForm = server.forms.getForm('newpasswords');
    var token = req.querystring.token;

    if (passwordForm.newpassword.value !== passwordForm.newpasswordconfirm.value) {
        passwordForm.valid = false;
        passwordForm.newpassword.valid = false;
        passwordForm.newpasswordconfirm.valid = false;
        passwordForm.newpasswordconfirm.error =
            Resource.msg('error.message.mismatch.newpassword', 'forms', null);
    }

    if (passwordForm.valid) {
        var result = {
            newPassword: passwordForm.newpassword.value,
            newPasswordConfirm: passwordForm.newpasswordconfirm.value,
            token: token,
            passwordForm: passwordForm
        };
        res.setViewData(result);
        this.on('route:BeforeComplete', function (req, res) { // eslint-disable-line no-shadow
            var formInfo = res.getViewData();
            var status;
            var resettingCustomer;
            Transaction.wrap(function () {
                resettingCustomer = CustomerMgr.getCustomerByToken(formInfo.token);
                status = resettingCustomer.profile.credentials.setPasswordWithToken(
                    formInfo.token,
                    formInfo.newPassword
                );
            });
            if (status.error) {
                passwordForm.newpassword.valid = false;
                passwordForm.newpasswordconfirm.valid = false;
                passwordForm.newpasswordconfirm.error =
                    Resource.msg('error.message.resetpassword.invalidformentry', 'forms', null);
                res.render('account/password/newpassword', {
                    passwordForm: passwordForm,
                    token: token
                });
            } else {
                var email = resettingCustomer.profile.email;
                var url = URLUtils.https('Login-Show');
                var objectForEmail = {
                    firstName: resettingCustomer.profile.firstName,
                    lastName: resettingCustomer.profile.lastName,
                    url: url
                };
                var passwordChangedEmail = new Mail();
                var context = new HashMap();
                Object.keys(objectForEmail).forEach(function (key) {
                    context.put(key, objectForEmail[key]);
                });

                passwordChangedEmail.addTo(email);
                passwordChangedEmail.setSubject(
                    Resource.msg('subject.profile.resetpassword.email', 'login', null));
                passwordChangedEmail.setFrom(
                    Site.current.getCustomPreferenceValue('customerServiceEmail')
                    || 'no-reply@salesforce.com');

                var template = new Template('account/password/passwordChangedEmail');
                var content = template.render(context).text;
                passwordChangedEmail.setContent(content, 'text/html', 'UTF-8');
                passwordChangedEmail.send();
                res.redirect(URLUtils.url('Login-Show'));
            }
        });
    } else {
        res.render('account/password/newpassword', { passwordForm: passwordForm, token: token });
    }
    next();
});


server.get('Header', server.middleware.include, function (req, res, next) {
    res.render('account/header', { name:
        req.currentCustomer.profile ? req.currentCustomer.profile.firstName : null
    });
    next();
});

server.get('Menu', server.middleware.include, function (req, res, next) {
    res.render('account/menu', { name:
        req.currentCustomer.profile ? req.currentCustomer.profile.firstName : null
    });
    next();
});

module.exports = server.exports();
